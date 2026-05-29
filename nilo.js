// nilo.js — entry point: bot creation and event wiring

require('dotenv').config();

require('./logger').install();

const mineflayer = require('mineflayer');
const { pathfinder }  = require('mineflayer-pathfinder');
const { goals: { GoalBlock } } = require('mineflayer-pathfinder');
const { plugin: collectblock } = require('mineflayer-collectblock');
const { plugin: movementPlugin } = require('mineflayer-movement');
const toolPlugin   = require('mineflayer-tool').plugin;
const armorManager    = require('mineflayer-armor-manager');
const autoEat         = require('mineflayer-auto-eat').loader;
const pvp             = require('mineflayer-pvp').plugin;
const minecraftHawkEye = require('minecrafthawkeye').default;
const skillEngine = require('./skill-engine');
const { installRegistryPatch, installBlockUpdateLearner, installProximityLearner, setManualOverride,
        buildEarlyRegistrationResponse, handleLoginRegistrySync, REGISTRY_SYNC_CHANNELS } = require('./registry-patch');
const { installContextModLearner } = require('./context-mod-client');
const { installViewers } = require('./viewer');

const state   = require('./state');
const { BOT_USERNAME, MASTER, getServerConfig, setActiveServer, loadServers,
        loadConfig, saveConfig } = require('./config');
const { isTrusted, trustPlayer, untrustPlayer, listTrusted } = require('./trust');
const { detectLanguage }   = require('./lang');
const { queryLetta, parseAction, chatLong } = require('./letta');
const { getInventorySummary }    = require('./items');
const { setBehavior, clearBehavior } = require('./behavior');
const { buildOpenableIds, createMovements, installDoorOpener, tryUnstuck, applyServerBlockOverrides } = require('./movement');
const { equipShield, equipBestMeleeWeapon } = require('./combat');
const { collectGrave, runFarm, writeSign, wrapSignText } = require('./activities');
const { installEasyAuth } = require('./easyauth');
const { startProximityMonitor, startAutonomousBehaviors, startSkillAutonomyTicker, watchLog } = require('./monitor');
const { sessionHintFor } = require('./monitor');
const { handleNaturalCommand } = require('./commands');
const { dispatchAction, runCommand } = require('./actions');
const { startDiscord, attachBot, stopDiscord } = require('./discord-bridge');

const CONVERSATION_WINDOW_MS = 30000; // 30s after last interaction, no trigger needed
const PROXIMITY_CHAT_RANGE   = 12;    // blocks — within this range, no trigger needed

// ── Bot creation ──────────────────────────────────────────────────────────────

function createBot() {
  const { host, port, version, auth } = getServerConfig();
  const bot = mineflayer.createBot({
    host,
    port,
    username: BOT_USERNAME,
    version,
    auth: auth || 'offline',
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectblock);
  bot.loadPlugin(movementPlugin);
  bot.loadPlugin(toolPlugin);
  bot.loadPlugin(armorManager);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(pvp);
  bot.loadPlugin(minecraftHawkEye);

  // Intercept Fabric's registry sync packet to learn modded block names
  installRegistryPatch(bot);

  // minecraft-protocol auto-responds to all login_plugin_request with null,
  // which causes duplicate responses. Remove it so we fully control the handshake.
  bot._client.removeAllListeners('login_plugin_request');

  bot._client.on('login_plugin_request', (packet) => {
    const bytes = packet.data?.length ?? 0;
    const hex   = bytes <= 16 ? (packet.data?.toString('hex') ?? '') : '';
    console.log(`[HANDSHAKE] login_plugin_request: ${packet.channel} (${bytes}b${hex ? ' 0x' + hex : ''})`);

    let responseData = null;

    if (packet.channel === 'fabric-networking-api-v1:early_registration') {
      // Respond claiming only registry-sync channels — nothing else, to avoid
      // triggering server-side verification Nilo can't pass.
      responseData = buildEarlyRegistrationResponse(packet.data ?? Buffer.alloc(1));
    } else if (REGISTRY_SYNC_CHANNELS.some(ch => ch === packet.channel)) {
      // Server is delivering the modded block/item registry during login phase.
      handleLoginRegistrySync(packet.data ?? Buffer.alloc(0));
      responseData = Buffer.from([0x01]); // acknowledge
    } else if (packet.channel === 'owo:handshake') {
      // oωo response: empty channel map (0x00) + version/compat byte (0x01)
      responseData = Buffer.from([0x00, 0x01]);
    } else if (packet.channel === 'forgeconfigapiport:sync_configs') {
      // ConfigSync.onSyncConfigs reads a String from the response — empty string = VarInt(0).
      responseData = Buffer.from([0x00]);
    } else if (packet.channel.startsWith('forgeconfigapiport:')) {
      responseData = Buffer.from([0x00]);
    } else if (packet.channel === 'fabric:custom_ingredient_sync') {
      // decodeResponsePacket reads: VarInt(protocolVersion) + VarInt(ingredientCount)
      // 0x01 = accept protocol version 1 (matches server), 0x00 = 0 custom ingredients.
      responseData = Buffer.from([0x01, 0x00]);
    } else if (packet.channel.startsWith('fabric:')) {
      // Other unknown Fabric channels: VarInt(0) is a safe default — better than
      // empty bytes, which crash mods that call readVarInt() without null-checking.
      responseData = Buffer.from([0x00]);
    }
    // All other channels: null = "not supported by this client"

    bot._client.write('login_plugin_response', {
      messageId: packet.messageId,
      data: responseData,
    });
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  bot.on('login', () => {
    const sc = getServerConfig();
    console.log(`[NILO] Connected to ${sc.host}:${sc.port} (${sc.version}) as ${BOT_USERNAME}`);
    state.activeBotRef = bot;

    // Forward Nilo's chat to any open CLI sessions.
    const _chat = bot.chat.bind(bot);
    bot.chat = (msg) => {
      _chat(msg);
      const payload = JSON.stringify({ type: 'nilo', text: String(msg) });
      for (const ws of state.cliClients) {
        if (ws.readyState === 1) ws.send(payload);
      }
    };

    // Keep sneak active across pathfinder resets — the pathfinder calls
    // clearControlStates internally on every path recalculation, which would
    // otherwise wipe the sneak state immediately after it's set.
    const _clearControlStates = bot.clearControlStates.bind(bot);
    bot.clearControlStates = function () {
      _clearControlStates();
      if (state.isSneaking) bot.setControlState('sneak', true);
    };

    // Patch server-specific block behaviours (floor tiles, etc.) once.
    applyServerBlockOverrides(bot);

    // Cache door-like block IDs once so createMovements and the door opener
    // share the same set without re-scanning the registry on every call.
    bot._openableIds = buildOpenableIds(bot);
    console.log(`[NILO] Openable blocks cached: ${bot._openableIds.size}`);

    // Give the pathfinder more time to solve complex modded terrain.
    bot.pathfinder.thinkingTimeout = 5000;

    // Auto-eat when hunger drops below 15 (out of 20)
    bot.autoEat.setOpts({
      priority:   'foodPoints',
      minHunger:  15,
      bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit'],
    });
    bot.autoEat.enableAuto();

    // Proactive door opener — bypasses the Fabric-broken executor door logic.
    installDoorOpener(bot);

    // Learn modded block stateIds from any block change in the world.
    installBlockUpdateLearner(bot);

    // Sample nearby stateIds while moving to feed gap-analysis over time.
    installProximityLearner(bot, state);

    // Query the server-side Fabric mod for ground-truth block names.
    // Compares against gap-analysis results and logs mismatches for diagnostics.
    installContextModLearner(bot);

    // Browser views — started after spawn so the bot inventory is ready.
    bot.once('spawn', () => {
      installViewers(bot).catch(err => console.error('[VIEWER] Error:', err.message));
    });

    // ── Path failure recovery ─────────────────────────────────────────────
    let stuckStreak  = 0;
    let lastStuckPos = null;

    bot.on('path_reset', (reason) => {
      if (reason !== 'stuck') return;

      const pos = bot.entity.position;
      if (lastStuckPos && pos.distanceTo(lastStuckPos) < 4) {
        stuckStreak++;
      } else {
        stuckStreak  = 1;
        lastStuckPos = pos.clone();
      }

      if (stuckStreak >= 3) {
        console.log('[NILO] Stuck streak: abandoning current path.');
        stuckStreak  = 0;
        lastStuckPos = null;
        bot.pathfinder.stop();
        if (!state.isMining && !state.isLooting && (state.behaviorMode === 'idle' || state.behaviorMode === 'wander')) {
          const p  = bot.entity.position;
          const rx = p.x + (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 15);
          const rz = p.z + (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 15);
          const mv = createMovements(bot);
          bot.pathfinder.setMovements(mv);
          bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(p.y), Math.floor(rz)));
        }
      } else {
        tryUnstuck(bot).catch(() => {});
      }
    });

    bot.on('path_update', (r) => {
      if (r.status !== 'noPath') return;
      console.log(`[NILO] No path found (${r.visitedNodes} nodes visited).`);
      stuckStreak  = 0;
      lastStuckPos = null;

      if (!state.isMining && !state.isLooting && (state.behaviorMode === 'idle' || state.behaviorMode === 'wander')) {
        const p  = bot.entity.position;
        const rx = p.x + (Math.random() * 30 - 15);
        const rz = p.z + (Math.random() * 30 - 15);
        const mv = createMovements(bot);
        bot.pathfinder.setMovements(mv);
        bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(p.y), Math.floor(rz)));
      }
    });

    startProximityMonitor(bot);
    startAutonomousBehaviors(bot);
    startSkillAutonomyTicker(bot);
    console.log(`[SKILL] Engine ready. ${skillEngine.skillCount()} skill(s) loaded.`);
    attachBot(bot);

    // ── Auto-fill blank signs placed by MASTER ───────────────────────────────
    // When MASTER places a sign within 8 blocks, Letta generates text and Nilo
    // writes on it automatically (Neuro-sama style).
    bot.on('blockUpdate', async (oldBlock, newBlock) => {
      if (!newBlock) return;
      if (!(newBlock.name.endsWith('_sign') || newBlock.name === 'sign')) return;

      const masterEntity = bot.players[MASTER]?.entity;
      if (!masterEntity) return;
      if (newBlock.position.distanceTo(masterEntity.position) > 8) return;
      if (newBlock.position.distanceTo(bot.entity.position) > 10) return;

      // Small delay — let the sign finish placing before we write on it
      await new Promise(r => setTimeout(r, 400));

      const freshBlock = bot.blockAt(newBlock.position);
      if (!freshBlock || !(freshBlock.name.endsWith('_sign') || freshBlock.name === 'sign')) return;

      // Check sign is blank (no existing text)
      const props = freshBlock.getProperties ? freshBlock.getProperties() : {};
      if (props.text1 || props.front_text) return; // already has text

      console.log('[NILO] Blank sign detected — asking Letta for text...');
      try {
        const raw = await queryLetta(
          `A blank sign was just placed nearby. Write something short and in-character ` +
          `for a sign (max 4 lines, 15 chars per line). Reply with ONLY the sign text, ` +
          `no explanation, no quotes.`
        );
        const { text } = parseAction(raw);
        if (text) {
          const lines = wrapSignText(text);
          await bot.updateSign(freshBlock, lines, true);
          console.log(`[NILO] Auto-signed: ${lines.filter(Boolean).join(' | ')}`);
        }
      } catch (err) {
        console.error('[NILO] Auto-sign error:', err.message);
      }
    });
  });

  installEasyAuth(bot);

  // ── Chat handler ──────────────────────────────────────────────────────────

  bot.on('chat', async (username, message) => {
    if (username === BOT_USERNAME) return;
    if (message.startsWith('!') && !message.toLowerCase().startsWith('!nilo')) return;

    const lower    = message.toLowerCase();
    const mentioned = lower.includes('nilo') || lower.startsWith('!nilo');

    // Disconnect command — MASTER only, no trigger word needed
    if (username === MASTER && /\b(leave( the game)?|disconnect|log off|log out|desconecta|sai do jogo|vai embora do servidor)\b/.test(lower)) {
      state.intentionalDisconnect = true;
      bot.chat('Logging off. See you later!');
      setTimeout(() => bot.quit(), 1000);
      return;
    }

    // Natural language assistance for MASTER — no trigger word needed
    if (username === MASTER) {
      let acted = false;
      try { acted = await handleNaturalCommand(bot, lower, message, username); }
      catch (err) { console.error('[NILO] handleNaturalCommand error:', err.message); }
      if (acted) { state.lastInteractionTime = Date.now(); return; }
    }

    // Determine if this message is directed at NILO
    const withinConversationWindow = (Date.now() - state.lastInteractionTime) < CONVERSATION_WINDOW_MS;
    const playerEntity = bot.players[username]?.entity;
    const withinRange  = playerEntity &&
      playerEntity.position.distanceTo(bot.entity.position) <= PROXIMITY_CHAT_RANGE;
    const addressedToNilo = mentioned || (username === MASTER && (withinConversationWindow || withinRange));

    if (!addressedToNilo) return;

    if (mentioned) state.lastInteractionTime = Date.now();

    // ── Admin commands (MASTER only) ──────────────────────────────────────
    if (username === MASTER) {
      if (lower.match(/^!nilo quit\b/)) {
        bot.chat('Disconnecting...');
        bot.quit();
        return;
      }

      const sayMatch = message.match(/^!nilo say (.+)/i);
      if (sayMatch) { bot.chat(sayMatch[1]); return; }

      const setFarmMatch = message.match(/^!nilo setfarm (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/i);
      if (setFarmMatch) {
        const [, x1, y1, z1, x2, y2, z2] = setFarmMatch.map((v, i) => i === 0 ? v : parseInt(v));
        const cfg = loadConfig();
        cfg.farm  = { x1, y1, z1, x2, y2, z2 };
        saveConfig(cfg);
        bot.chat(`Farm area set: (${x1},${y1},${z1}) to (${x2},${y2},${z2}).`);
        return;
      }

      const setChestMatch = message.match(/^!nilo setchest (-?\d+) (-?\d+) (-?\d+)/i);
      if (setChestMatch) {
        const [, x, y, z] = setChestMatch.map((v, i) => i === 0 ? v : parseInt(v));
        const cfg = loadConfig();
        cfg.chest = { x, y, z };
        saveConfig(cfg);
        bot.chat(`Chest set at (${x},${y},${z}).`);
        return;
      }

      if (lower.match(/^!nilo farm\b/)) { runFarm(bot); return; }

      // ── Skill engine commands ─────────────────────────────────────────────

      const learnMatch = message.match(/^!nilo learn\s+(.+)/i);
      if (learnMatch) {
        if (state.skillLearnInProgress) { bot.chat('Already learning something. Give me a moment.'); return; }
        state.skillLearnInProgress = true;
        skillEngine.learnSkill(bot, learnMatch[1].trim())
          .catch(e => { console.error('[SKILL] learnSkill error:', e.message); bot.chat('Something went wrong while learning.'); })
          .finally(() => { state.skillLearnInProgress = false; });
        return;
      }

      const doMatch = message.match(/^!nilo do\s+(\S+)/i);
      if (doMatch) {
        const skillName = doMatch[1].trim().toLowerCase();
        bot.chat(`Running skill: ${skillName}...`);
        skillEngine.runSkill(bot, skillName)
          .then(({ success, result, error }) => {
            bot.chat(success ? `Done: ${String(result ?? skillName).slice(0, 60)}` : `Skill failed: ${error}`);
          })
          .catch(e => bot.chat(`Error: ${e.message}`));
        return;
      }

      if (lower.match(/^!nilo skills?\b/)) {
        const list   = skillEngine.listSkills();
        const chunks = list.match(/.{1,200}(?:\s|$)/g) || [list];
        for (const chunk of chunks) bot.chat(chunk.trim());
        return;
      }

      const forgetMatch = message.match(/^!nilo forget\s+(\S+)/i);
      if (forgetMatch) {
        const skillName = forgetMatch[1].trim().toLowerCase();
        const ok = skillEngine.deleteSkill(skillName);
        bot.chat(ok ? `Forgot skill: ${skillName}.` : `No skill named ${skillName}.`);
        return;
      }

      const queueMatch = message.match(/^!nilo queue\s+(.+)/i);
      if (queueMatch) {
        skillEngine.queueGoal(queueMatch[1].trim());
        bot.chat(`Added to curriculum: "${queueMatch[1].trim().slice(0, 50)}"`);
        return;
      }

      if (lower.match(/^!nilo autonomous on\b/)) {
        state.autonomousSkillsEnabled = true;
        bot.chat(`Autonomous mode ON. I will learn new skills when idle. (${skillEngine.skillCount()} skills known)`);
        return;
      }
      if (lower.match(/^!nilo autonomous off\b/)) {
        state.autonomousSkillsEnabled = false;
        bot.chat('Autonomous mode OFF.');
        return;
      }
      if (lower.match(/^!nilo autonomous\b/)) {
        bot.chat(`Autonomous mode is currently ${state.autonomousSkillsEnabled ? 'ON' : 'OFF'}. Use !nilo autonomous on/off.`);
        return;
      }

      const trustMatch = message.match(/^!nilo trust (\S+)/i);
      if (trustMatch) {
        trustPlayer(trustMatch[1]);
        bot.chat(`${trustMatch[1]} is now trusted.`);
        return;
      }

      const untrustMatch = message.match(/^!nilo (?:untrust|distrust) (\S+)/i);
      if (untrustMatch) {
        untrustPlayer(untrustMatch[1]);
        bot.chat(`${untrustMatch[1]} is no longer trusted.`);
        return;
      }

      if (lower.match(/^!nilo trusted\b/)) {
        const list = listTrusted().join(', ');
        bot.chat(list ? `Trusted: ${list}` : 'No trusted players.');
        return;
      }
    }

    // ── Behavior commands for trusted non-MASTER players ──────────────────
    if (username !== MASTER) {
      if (isTrusted(username)) {
        const masterLocked = state.behaviorOwner === MASTER;

        if (lower.match(/^!nilo follow\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          const { startFollow } = require('./movement');
          startFollow(bot, username, 2);
          bot.chat(`Following you, ${username}.`);
          return;
        }
        if (lower.match(/^!nilo stay\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'idle', username); bot.chat('Staying put.'); return;
        }
        if (lower.match(/^!nilo sit\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'sit', username); bot.setControlState('sneak', true); bot.chat('Sitting.'); return;
        }
        if (lower.match(/^!nilo wander\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'wander', username); bot.chat('Going for a wander.'); return;
        }
        if (lower.match(/^!nilo attack\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          const { startAttack } = require('./combat');
          startAttack(bot, username);
          return;
        }
        if (lower.match(/^!nilo defensive\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'defensive', username); bot.chat('Defensive mode.'); return;
        }
        if (lower.match(/^!nilo passive\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'passive', username); bot.chat('Passive mode.'); return;
        }
      }
    }

    // ── Send to Letta ─────────────────────────────────────────────────────
    const cleaned = message
      .replace(/!nilo\s*/i, '')
      .replace(/\bnilo\b[,:]?\s*/i, '')
      .trim();

    if (!cleaned) {
      bot.chat(`Hey ${username}.`);
      return;
    }

    console.log(`[NILO] ${username}: ${cleaned}`);

    try {
      const inv    = getInventorySummary(bot);
      const held   = bot.heldItem ? bot.heldItem.name : 'nothing';
      const lang   = detectLanguage(cleaned);
      const actionHint = `[Available actions — if the message implies one, append [ACTION: name] at the very end of your reply: follow, stay, sit, stop, come, closer, unstuck, dance, fish, stop_fish, bow, shoot_target, tunnel, build_house, sleep, wander, attack, guard, defensive, passive, explore, stop_explore, collect_grave, wave, spin, jump, ensure_tools, sneak, stand]`;
      const ctx  = `${sessionHintFor(username)}${username} says: ${cleaned}\n[My inventory: ${inv}. Holding: ${held}. Respond in: ${lang}]\n[Tone: reply in 1 short casual sentence, like a real person talking — no narration, no explaining what you're doing, never mention the modpack or server name]\n${actionHint}`;
      const raw  = await queryLetta(ctx);
      const { text, action } = parseAction(raw);
      console.log(`[NILO] -> ${text}${action ? ` [ACTION: ${action}]` : ''}`);
      state.lastInteractionTime = Date.now();
      if (text)   await chatLong(bot, text);
      if (action) dispatchAction(bot, action, username);
    } catch (err) {
      console.error('[NILO] Letta error:', err.message);
      bot.chat('My thoughts are unclear right now. Try again in a moment.');
    }
  });

  // ── Death & respawn ───────────────────────────────────────────────────────

  bot.on('death', () => {
    console.log('[NILO] Died. Respawning...');
    state.isFarming    = false;
    state.isLooting    = false;
    state.justDied     = true;
    state.deathPosition = bot.entity.position.clone();
    clearBehavior(bot);
    state.behaviorMode = 'idle';
    setManualOverride(bot, 588209, 'yigd:grave');
    bot.respawn();
  });

  bot.on('spawn', async () => {
    if (!state.justDied) return;
    state.justDied = false;
    await new Promise(r => setTimeout(r, 3000)); // let the grave block load
    console.log('[NILO] Looking for grave after death...');
    await collectGrave(bot);
  });

  // ── Defensive retaliation ─────────────────────────────────────────────────

  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    if (state.behaviorMode !== 'defensive') return;
    const attacker = bot.nearestEntity(e =>
      e !== bot.entity && e.position.distanceTo(bot.entity.position) < 8
    );
    if (!attacker) return;
    equipShield(bot);
    equipBestMeleeWeapon(bot);
    bot.activateItem(true); // raise shield immediately on hit
    bot.lookAt(attacker.position.offset(0, attacker.height * 0.9, 0), true)
      .then(() => bot.attack(attacker))
      .catch(() => {});
  });

  // ── Error / disconnect ────────────────────────────────────────────────────

  bot.on('kicked', (reason) => {
    console.error('[NILO] Kicked:', reason);
  });

  bot.on('error', (err) => {
    if (err.name === 'PartialReadError') return;
    console.error('[NILO] Bot error:', err.message || err.code || JSON.stringify(err));
  });

  bot.on('end', () => {
    state.activeBotRef = null;
    state.isFarming    = false;
    state.isMining     = false;
    state.isSneaking   = false;
    if (state.behaviorInterval)  { clearInterval(state.behaviorInterval);  state.behaviorInterval  = null; }
    if (state.proximityInterval) { clearInterval(state.proximityInterval); state.proximityInterval = null; }
    if (state.autonomousInterval){ clearInterval(state.autonomousInterval);state.autonomousInterval = null; }
    state.isLooting    = false;
    state.behaviorMode = 'idle';
    if (state.intentionalDisconnect) {
      console.log('[NILO] Disconnected intentionally. Staying offline.');
      state.intentionalDisconnect = false;
      return;
    }
    console.log('[NILO] Disconnected. Reconnecting in 10s...');
    setTimeout(createBot, 10000);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// Parse --server=<name> or --server <name> from CLI
const serverArgIdx = process.argv.findIndex(a => a === '--server' || a.startsWith('--server='));
if (serverArgIdx !== -1) {
  const arg = process.argv[serverArgIdx];
  const name = arg.includes('=') ? arg.split('=')[1] : process.argv[serverArgIdx + 1];
  if (name) {
    try { setActiveServer(name); }
    catch (e) {
      console.error('[SERVER] ' + e.message);
      const servers = loadServers();
      console.error('[SERVER] Available profiles:', Object.keys(servers).join(', ') || '(none in servers.json)');
    }
  }
}

watchLog();
startDiscord();   // Discord up immediately — works even before Minecraft connects

// ── Local CLI session (WebSocket) ─────────────────────────────────────────────
// Clients connect on ws://localhost:4000.
// They send plain-text commands; Nilo's chat replies are forwarded back.
// Run: node /home/prizmo/nilo-project/nilo/nilo-cli.js  (or just type "nilo")
{
  const { WebSocketServer } = require('ws');
  const CLI_PORT = parseInt(process.env.CLI_PORT || '4000', 10);
  const cliClients = new Set();

  const wss = new WebSocketServer({ host: '127.0.0.1', port: CLI_PORT });

  // Expose so the bot login handler can patch bot.chat
  state.cliClients = cliClients;

  wss.on('connection', ws => {
    cliClients.add(ws);
    const bot = state.activeBotRef;
    const status = bot ? `connected to ${getServerConfig().host}` : 'bot offline';
    ws.send(JSON.stringify({ type: 'status', text: status }));

    ws.on('message', async data => {
      const message = data.toString().trim();
      if (!message) return;
      const bot = state.activeBotRef;
      if (!bot) { ws.send(JSON.stringify({ type: 'error', text: 'Bot not connected.' })); return; }
      try {
        await handleNaturalCommand(bot, message.toLowerCase(), message, MASTER);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', text: err.message }));
      }
    });

    ws.on('close', () => cliClients.delete(ws));
  });

  console.log(`[CLI] Chat session → type "nilo" in terminal`);
}

createBot();

process.on('SIGTERM', async () => {
  let reason = 'stop';
  try { reason = require('fs').readFileSync('/tmp/nilo_stop_reason', 'utf8').trim(); require('fs').unlinkSync('/tmp/nilo_stop_reason'); } catch (_) {}
  await stopDiscord(reason);
  process.exit(0);
});
process.on('SIGINT',  async () => { await stopDiscord('stop'); process.exit(0); });
