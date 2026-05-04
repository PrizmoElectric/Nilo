// monitor.js — proximity/health monitor, autonomous behaviors, skill ticker, log watcher

const fs       = require('fs');
const readline = require('readline');
const skillEngine = require('./skill-engine');
const state    = require('./state');
const { setBehavior } = require('./behavior');
const { createMovements } = require('./movement');
const { isHostileMob } = require('./combat');
const { queryLetta, parseAction, chatLong } = require('./letta');
const { MASTER, BOT_USERNAME, DEATH_VERBS, ADVANCEMENT_RE, JOIN_RE, LEAVE_RE, getServerConfig } = require('./config');
const { goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');

// ── Session hint ──────────────────────────────────────────────────────────────

// Prepend a [NEW SESSION] hint if the last real interaction was >5 min ago,
// to stop Letta bleeding old memory topics into proactive events.
function sessionHintFor(username) {
  const fresh = state.lastInteractionTime === 0 || (Date.now() - state.lastInteractionTime) > 300000;
  return fresh
    ? '[NEW SESSION — respond only to the current event, do not reference past conversations unprompted]\n'
    : '';
}

// ── Proximity & health monitor ────────────────────────────────────────────────

function startProximityMonitor(bot) {
  if (state.proximityInterval) clearInterval(state.proximityInterval);

  let wasInRange              = false;
  let lowHealthWarned         = false;
  let lastGreetTime           = 0;
  let lastFollowComplaintTime = 0;
  let lastThreatWarnTime      = 0;
  let knownThreats            = new Set(); // entity IDs seen this threat cycle
  const RANGE                    = 15;
  const LOW_HEALTH               = 8; // out of 20
  const THREAT_RANGE             = 16;
  const GREET_COOLDOWN_MS        = 120000; // 2 min between greets
  const FOLLOW_COMPLAINT_COOLDOWN_MS = 90000;
  const THREAT_WARN_COOLDOWN_MS  = 20000;  // 20s between threat warnings
  const STARTUP_GRACE_MS         = 30000;  // suppress all proactive events for 30s after join
  const startTime                = Date.now();

  state.proximityInterval = setInterval(async () => {
    const player = bot.players[MASTER];
    const entity = player?.entity;

    // ── Health check ──────────────────────────────────────────────────────
    if (bot.health <= LOW_HEALTH && !lowHealthWarned && Date.now() - startTime > STARTUP_GRACE_MS) {
      lowHealthWarned = true;
      try {
        const response = await queryLetta(
          `${sessionHintFor(MASTER)}[HEALTH EVENT] Your current health is ${bot.health}/20. React briefly in character — you feel unwell.\n[Respond in: en]`
        );
        const { text: healthText } = parseAction(response);
        if (healthText) await chatLong(bot, healthText);
      } catch (_) {}
    }
    if (bot.health > LOW_HEALTH) lowHealthWarned = false;

    // ── Threat scan ───────────────────────────────────────────────────────
    if (state.behaviorMode === 'follow' || state.behaviorMode === 'idle' || state.behaviorMode === 'wander') {
      const now2 = Date.now();
      if (now2 - startTime > STARTUP_GRACE_MS) {
        const nearbyHostiles = Object.values(bot.entities).filter(e =>
          isHostileMob(e) && e.position.distanceTo(bot.entity.position) < THREAT_RANGE
        );
        const newThreats = nearbyHostiles.filter(e => !knownThreats.has(e.id));
        if (newThreats.length > 0 && now2 - lastThreatWarnTime >= THREAT_WARN_COOLDOWN_MS) {
          lastThreatWarnTime = now2;
          const names = [...new Set(newThreats.map(e => e.name))].join(', ');
          queryLetta(
            `${sessionHintFor(MASTER)}[THREAT EVENT] You just spotted hostile mob(s) nearby: ${names}. React briefly — a quick warning or tense observation.\n[Respond in: en]`
          ).then(r => { const { text: t } = parseAction(r); if (t) chatLong(bot, t); }).catch(() => {});
        }
        knownThreats = new Set(nearbyHostiles.map(e => e.id));
      }
    }

    // ── Proximity check ───────────────────────────────────────────────────
    if (!entity) { wasInRange = false; return; }

    const dist  = entity.position.distanceTo(bot.entity.position);
    const inRange = dist <= RANGE;
    const now   = Date.now();

    if (inRange && !wasInRange) {
      wasInRange = true;
      if (now - startTime > STARTUP_GRACE_MS && now - lastGreetTime >= GREET_COOLDOWN_MS) {
        lastGreetTime = now;
        try {
          const response = await queryLetta(
            `${sessionHintFor(MASTER)}[PROXIMITY EVENT] PrizmoElectric just came within ${Math.floor(dist)} blocks of you. Greet them briefly in character.\n[Respond in: en]`
          );
          const { text: greetText } = parseAction(response);
          if (greetText) await chatLong(bot, greetText);
        } catch (_) {}
      }
    }

    if (!inRange && wasInRange) {
      wasInRange = false;
      if (state.behaviorMode === 'follow' && now - lastFollowComplaintTime >= FOLLOW_COMPLAINT_COOLDOWN_MS) {
        lastFollowComplaintTime = now;
        try {
          const response = await queryLetta(
            `${sessionHintFor(MASTER)}[PROXIMITY EVENT] PrizmoElectric moved far away and you're having trouble keeping up while following them. Say something brief in character.\n[Respond in: en]`
          );
          const { text: followText } = parseAction(response);
          if (followText) await chatLong(bot, followText);
        } catch (_) {}
      }
    }
  }, 2000);
}

// ── Autonomous behaviors ──────────────────────────────────────────────────────

function startAutonomousBehaviors(bot) {
  if (state.autonomousInterval) clearInterval(state.autonomousInterval);

  let lookCooldown    = 0;
  let exploreCooldown = 0;

  state.autonomousInterval = setInterval(async () => {
    // ── Natural look ──────────────────────────────────────────────────────
    if (lookCooldown > 0) {
      lookCooldown--;
    } else {
      const target = bot.nearestEntity(e => {
        if (e === bot.entity) return false;
        const dist = e.position.distanceTo(bot.entity.position);
        return dist < 10 && dist > 0.5 && (e.type === 'player' || e.type === 'mob');
      });
      if (target && Math.random() > 0.4) {
        const headOffset = target.height != null ? target.height : 1.6;
        bot.lookAt(target.position.offset(0, headOffset, 0), false).catch(() => {});
        lookCooldown = 3 + Math.floor(Math.random() * 5);
      }
    }

    // ── Exploration ───────────────────────────────────────────────────────
    if (!state.exploringEnabled || state.isFarming || state.isLooting || state.behaviorMode !== 'idle') return;

    if (exploreCooldown > 0) { exploreCooldown--; return; }
    exploreCooldown = 4 + Math.floor(Math.random() * 4); // 8–16s between steps

    // Check for nearby chests first
    const chestBlock = bot.findBlock({
      matching: b => b.name === 'chest' || b.name === 'trapped_chest',
      maxDistance: 24,
    });

    if (chestBlock) {
      state.isLooting = true;
      try {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        const p = chestBlock.position;
        await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));
        const container = await bot.openContainer(chestBlock);
        const items = container.containerItems();
        container.close();

        const preview = items.length
          ? items.slice(0, 6).map(i => `${i.count}x ${i.name}`).join(', ')
          : 'nothing';
        const response = await queryLetta(
          `[AUTONOMOUS] While exploring you found and opened a chest at (${p.x},${p.y},${p.z}). ` +
          `Contents: ${preview}. React briefly in character — curiosity, excitement, or disappointment.\n[Respond in: en]`
        );
        const { text: chestText } = parseAction(response);
        if (chestText) await chatLong(bot, chestText);
      } catch (err) {
        console.error('[NILO] Chest loot error:', err.message);
      }
      state.isLooting = false;
      return;
    }

    // No chest nearby — wander to a random position
    const pos = bot.entity.position;
    const rx  = pos.x + (Math.random() * 40 - 20);
    const rz  = pos.z + (Math.random() * 40 - 20);
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(pos.y), Math.floor(rz)));
  }, 2000);
}

// ── Skill autonomy ticker ─────────────────────────────────────────────────────

function startSkillAutonomyTicker(bot) {
  setInterval(async () => {
    if (!state.autonomousSkillsEnabled) return;
    if (state.skillLearnInProgress) return;
    if (state.behaviorMode !== 'idle') return;
    if (state.isFarming || state.isLooting) return;

    state.skillLearnInProgress = true;
    try {
      await skillEngine.autonomousTick(bot, state.lastInteractionTime);
    } catch (err) {
      console.error('[SKILL] Autonomous tick error:', err.message);
    } finally {
      state.skillLearnInProgress = false;
    }
  }, 60_000); // check every minute; engine enforces 10-min gap internally
}

// ── Log watcher ───────────────────────────────────────────────────────────────

function handleLogEvent(payload) {
  const bot = state.activeBotRef;
  if (!bot) return;

  let eventMsg = null;

  const joinMatch = payload.match(JOIN_RE);
  if (joinMatch && joinMatch[1] !== BOT_USERNAME) {
    eventMsg = `[SERVER EVENT] ${joinMatch[1]} joined the server.`;
  }

  const leaveMatch = payload.match(LEAVE_RE);
  if (leaveMatch && leaveMatch[1] !== BOT_USERNAME) {
    eventMsg = `[SERVER EVENT] ${leaveMatch[1]} left the server.`;
  }

  const deathMatch = payload.match(DEATH_VERBS);
  if (deathMatch && deathMatch[1] !== BOT_USERNAME) {
    eventMsg = `[SERVER EVENT] Death message: "${payload}"`;
  }

  const advMatch = payload.match(ADVANCEMENT_RE);
  if (advMatch) {
    eventMsg = `[SERVER EVENT] ${advMatch[1]} earned the advancement "${advMatch[3]}".`;
  }

  if (!eventMsg) return;

  console.log(`[NILO] Log event: ${eventMsg}`);
  queryLetta(sessionHintFor('') + eventMsg + '\n[Respond in: en]')
    .then((response) => {
      const { text } = parseAction(response);
      console.log(`[NILO] -> ${text}`);
      if (text) chatLong(bot, text);
    })
    .catch((err) => { console.error('[NILO] Letta error on log event:', err.message); });
}

function watchLog() {
  const logPath = getServerConfig().log_path;
  if (!logPath) {
    console.log('[NILO] No log_path configured for this server — log watching disabled.');
    return;
  }

  let fileSize = 0;
  try { fileSize = fs.statSync(logPath).size; } catch (_) {}

  fs.watchFile(logPath, { interval: 1000 }, (curr) => {
    if (curr.size <= fileSize) { fileSize = curr.size; return; }

    const stream = fs.createReadStream(logPath, { start: fileSize, end: curr.size - 1 });
    fileSize = curr.size;

    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      const infoMatch = line.match(/\[Server thread\/INFO\]: (.+)$/);
      if (!infoMatch) return;
      handleLogEvent(infoMatch[1]);
    });
  });

  console.log(`[NILO] Watching log: ${logPath}`);
}

module.exports = {
  sessionHintFor,
  startProximityMonitor, startAutonomousBehaviors, startSkillAutonomyTicker,
  watchLog,
};
