'use strict';

// ── Nilo Skill Engine (Voyager-concept) ───────────────────────────────────────
// Three agents:
//   Action agent  — Ollama generates Mineflayer JS for a task description
//   Critic        — executes code, catches errors, checks inventory delta
//   Curriculum    — a goal queue Nilo works through autonomously when idle

const fs   = require('fs');
const path = require('path');
const http = require('http');

const SKILLS_DIR      = path.join(__dirname, 'skills');
const MANIFEST_PATH   = path.join(SKILLS_DIR, 'manifest.json');
const CODE_MODEL      = process.env.NILO_CODE_MODEL || 'llama3.1:8b';
const MAX_RETRIES     = 3;
const SKILL_TIMEOUT   = 45_000; // ms per execution attempt
const OLLAMA_TIMEOUT  = 120_000; // ms for LLM response

// Starter curriculum — generic safe tasks Nilo attempts autonomously.
// Add more via !nilo queue <task>.
const STARTER_CURRICULUM = [
  'look around and describe what you see nearby',
  'check your inventory and report what you are carrying',
  'find a safe elevated spot nearby and note its coordinates',
];

// ── Manifest ──────────────────────────────────────────────────────────────────

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
  catch (_) { return {}; }
}

function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

// ── Ollama (direct HTTP — no extra deps) ──────────────────────────────────────

function ollamaGenerate(prompt) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model:   CODE_MODEL,
      prompt,
      stream:  false,
      options: { temperature: 0.15, num_predict: 900 },
    }));

    const req = http.request({
      hostname: 'localhost',
      port:     11434,
      path:     '/api/generate',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try   { resolve(JSON.parse(data).response || ''); }
        catch (e) { reject(new Error(`Ollama parse error: ${e.message}`)); }
      });
    });

    req.setTimeout(OLLAMA_TIMEOUT, () => { req.destroy(); reject(new Error('Ollama request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Code extraction ───────────────────────────────────────────────────────────
// The prompt ends with "async function niloSkill(bot) {" so the LLM either:
//   (a) continues with just the function body
//   (b) writes the full function again (common with instruction-tuned models)
//   (c) wraps everything in a ```js block

function extractFunctionBody(raw) {
  let text = raw.trim();

  // Strip markdown code fences
  const fenced = text.match(/```(?:js|javascript)?\s*\n?([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  // If a complete function definition is present, extract body only
  const fullFn = text.match(/async\s+function\s+\w+\s*\(\s*bot\s*\)\s*\{([\s\S]*)\}\s*$/s);
  if (fullFn) return fullFn[1].trim();

  // LLM continued from our partial — text is the body, may end with closing }
  if (text.endsWith('}')) text = text.slice(0, -1).trimEnd();
  return text;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(task, worldState, previousError) {
  const errorBlock = previousError
    ? `\nThe previous attempt failed with this error — fix it:\n  ${previousError}\n`
    : '';

  return `You are writing Mineflayer bot code for a Minecraft bot named NILO (version 1.20.1, Fabric modded server).
Write a single async JavaScript function that accomplishes the task.

STRICT RULES:
- Signature must be: async function niloSkill(bot) {
- These identifiers are already in scope — do NOT require them:
    GoalBlock(x,y,z)   GoalNear(x,y,z,range)   Vec3(x,y,z)   Movements
- Use these bot APIs only:
    bot.entity.position           Vec3 {x,y,z}
    bot.inventory.items()         [{name,count,type}]
    bot.heldItem                  item or null
    bot.health  bot.food          numbers
    bot.time.timeOfDay            number
    bot.findBlock({matching,maxDistance})      nearest block
    bot.findBlocks({matching,maxDistance,count}) multiple blocks
    bot.blockAt(vec3)             Block
    bot.pathfinder.goto(goal)     async navigate
    bot.pathfinder.setMovements(m)
    bot.collectBlock.collect(block)   async mine/collect
    bot.chat(text)                say in chat (≤2 sentences)
    bot.equip(item,slot)          async equip
    bot.attack(entity)
    bot.nearestEntity(filter)
    bot.entities                  object of all entities
- Throw Error with a useful message if the task cannot be done
- Return a short string describing what was accomplished
- Maximum 60 lines inside the function
- No outer require() calls${errorBlock}

CURRENT BOT STATE:
${worldState}

TASK: ${task}

Respond with ONLY the JavaScript function body (the code that goes inside the braces). No explanation. No imports. No module.exports.

async function niloSkill(bot) {`;
}

// ── Code execution ────────────────────────────────────────────────────────────

function executeBody(bot, bodyCode) {
  // Wrap body in a full function with injected scope
  const src = `
    const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
    const Vec3 = require('vec3');
    async function niloSkill(bot) {
      ${bodyCode}
    }
    return niloSkill(bot);
  `;

  let fn;
  try {
    fn = new Function('bot', 'require', src); // eslint-disable-line no-new-func
  } catch (e) {
    return Promise.reject(new Error(`Syntax error in generated code: ${e.message}`));
  }

  const p = fn(bot, require);
  if (!p || typeof p.then !== 'function') {
    return Promise.reject(new Error('Generated skill did not return a Promise'));
  }

  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Skill timed out after ${SKILL_TIMEOUT / 1000}s`)), SKILL_TIMEOUT)),
  ]);
}

// ── World state snapshot ──────────────────────────────────────────────────────

function worldState(bot) {
  const pos = bot.entity.position;
  const inv = bot.inventory.items().map(i => `${i.count}x ${i.name}`).join(', ') || 'empty';
  const held = bot.heldItem ? bot.heldItem.name : 'nothing';

  const nearby = [];
  const seen = new Set();
  const offsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[2,0,0],[0,0,2],[3,0,0],[0,0,3]];
  for (const [ox, oy, oz] of offsets) {
    const b = bot.blockAt(pos.offset(ox, oy, oz));
    if (b && b.name !== 'air' && b.name !== 'cave_air' && !seen.has(b.name)) {
      seen.add(b.name); nearby.push(b.name);
    }
  }

  return [
    `Position: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`,
    `Inventory: ${inv}`,
    `Holding: ${held}`,
    `Health: ${bot.health}/20  Food: ${bot.food}/20`,
    `Nearby blocks: ${nearby.join(', ') || 'none'}`,
  ].join('\n');
}

// ── Skill persistence ─────────────────────────────────────────────────────────

function taskToName(task) {
  return task.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('_');
}

function saveSkill(skillName, description, bodyCode) {
  const file = `${skillName}.js`;
  const content = [
    `// Skill: ${skillName}`,
    `// Description: ${description}`,
    `// Generated: ${new Date().toISOString()}`,
    `const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');`,
    `const Vec3 = require('vec3');`,
    ``,
    `async function niloSkill(bot) {`,
    bodyCode.split('\n').map(l => '  ' + l).join('\n'),
    `}`,
    ``,
    `module.exports = niloSkill;`,
  ].join('\n');

  fs.writeFileSync(path.join(SKILLS_DIR, file), content);

  const m = loadManifest();
  m[skillName] = {
    name:        skillName,
    description,
    file,
    successes: (m[skillName]?.successes || 0) + 1,
    failures:    m[skillName]?.failures  || 0,
    created:     m[skillName]?.created   || new Date().toISOString().slice(0, 10),
    updated:     new Date().toISOString().slice(0, 10),
  };
  saveManifest(m);
  console.log(`[SKILL] Saved: ${skillName}`);
}

function bumpFailure(skillName) {
  const m = loadManifest();
  if (m[skillName]) { m[skillName].failures = (m[skillName].failures || 0) + 1; saveManifest(m); }
}

function loadSkillFn(skillName) {
  const m = loadManifest();
  if (!m[skillName]) return null;
  const fp = path.join(SKILLS_DIR, m[skillName].file);
  if (!fs.existsSync(fp)) return null;
  delete require.cache[require.resolve(fp)]; // always load fresh
  return require(fp);
}

// ── Public API ────────────────────────────────────────────────────────────────

// learnSkill — Action agent + Critic loop. Up to MAX_RETRIES attempts.
// Returns { success, skillName, result?, error? }
async function learnSkill(bot, task) {
  const skillName = taskToName(task);
  console.log(`[SKILL] Learning "${task}" -> ${skillName}`);
  bot.chat(`On it. Learning: ${task.slice(0, 48)}...`);

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[SKILL] Attempt ${attempt}/${MAX_RETRIES}`);

    // ── Action agent ─────────────────────────────────────────────────────────
    let raw;
    try {
      raw = await ollamaGenerate(buildPrompt(task, worldState(bot), lastError));
    } catch (e) {
      const msg = `Ollama unavailable: ${e.message}`;
      console.error('[SKILL]', msg);
      bot.chat("Can't reach Ollama right now.");
      return { success: false, skillName, error: msg };
    }

    const bodyCode = extractFunctionBody(raw);
    console.log(`[SKILL] Code (${bodyCode.split('\n').length} lines):\n${bodyCode.slice(0, 200)}...`);

    // ── Critic (execute & verify) ─────────────────────────────────────────────
    const invBefore = bot.inventory.items().map(i => `${i.count}x${i.name}`).join(',');
    try {
      const result = await executeBody(bot, bodyCode);
      const invAfter  = bot.inventory.items().map(i => `${i.count}x${i.name}`).join(',');
      const changed   = invBefore !== invAfter;
      console.log(`[SKILL] Executed OK. Inventory changed: ${changed}. Result: ${result}`);

      saveSkill(skillName, task, bodyCode);
      bot.chat(`Learned: ${skillName}. ${String(result ?? 'Done').slice(0, 55)}`);
      return { success: true, skillName, result };
    } catch (execErr) {
      lastError = execErr.message;
      bumpFailure(skillName);
      console.error(`[SKILL] Attempt ${attempt} failed: ${execErr.message}`);
      if (attempt < MAX_RETRIES) bot.chat(`Attempt ${attempt} failed — retrying...`);
    }
  }

  bot.chat(`Couldn't learn that after ${MAX_RETRIES} tries. Sorry.`);
  return { success: false, skillName, error: lastError };
}

// runSkill — load a saved skill by name and execute it
async function runSkill(bot, skillName) {
  const fn = loadSkillFn(skillName);
  if (!fn) return { success: false, error: `No skill named "${skillName}"` };

  console.log(`[SKILL] Running: ${skillName}`);
  try {
    const result = await Promise.race([
      fn(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Skill timed out')), SKILL_TIMEOUT)),
    ]);
    const m = loadManifest();
    if (m[skillName]) { m[skillName].successes++; saveManifest(m); }
    return { success: true, result };
  } catch (e) {
    bumpFailure(skillName);
    return { success: false, error: e.message };
  }
}

// listSkills — formatted string for chat
function listSkills() {
  const entries = Object.values(loadManifest());
  if (!entries.length) return 'No skills learned yet. Use !nilo learn <task>.';
  return entries.map(e => `${e.name}(${e.successes}✓/${e.failures}✗)`).join('  ');
}

// deleteSkill — remove from disk + manifest
function deleteSkill(skillName) {
  const m = loadManifest();
  if (!m[skillName]) return false;
  const fp = path.join(SKILLS_DIR, m[skillName].file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  delete m[skillName];
  saveManifest(m);
  return true;
}

// skillCount
function skillCount() { return Object.keys(loadManifest()).length; }

// hasSkill — true if a skill with this exact name exists in the manifest
function hasSkill(name) { return Object.prototype.hasOwnProperty.call(loadManifest(), name); }

// ── Curriculum ────────────────────────────────────────────────────────────────
// A FIFO goal queue. Nilo works through it automatically when autonomous mode
// is enabled and the bot has been idle with no player nearby for 10+ minutes.

const goalQueue = [...STARTER_CURRICULUM];
let   lastAutonomousTick = 0;
const AUTONOMOUS_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Push a new goal to the front of the queue (immediate priority)
function queueGoal(task) { goalQueue.push(task); }

// Called from nilo.js autonomous ticker (only when bot is truly idle)
async function autonomousTick(bot, lastInteractionTime) {
  if (!goalQueue.length) return;
  const now = Date.now();
  if (now - lastInteractionTime < AUTONOMOUS_INTERVAL) return; // player was active recently
  if (now - lastAutonomousTick   < AUTONOMOUS_INTERVAL) return; // already ran recently

  lastAutonomousTick = now;
  const task = goalQueue.shift();
  console.log(`[SKILL] Autonomous goal: "${task}"`);

  // Check if we already have this skill
  const skillName = taskToName(task);
  const fn = loadSkillFn(skillName);
  if (fn) {
    const { success, result, error } = await runSkill(bot, skillName);
    bot.chat(success ? `[auto] ${String(result ?? skillName).slice(0, 60)}` : `[auto] ${skillName} failed: ${error}`);
  } else {
    await learnSkill(bot, task);
  }

  // Re-queue completed goals so the curriculum loops
  goalQueue.push(task);
}

module.exports = { learnSkill, runSkill, listSkills, hasSkill, deleteSkill, skillCount, queueGoal, autonomousTick, worldState };
