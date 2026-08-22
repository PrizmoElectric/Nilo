// nilo.js — entry point: bot creation and event wiring

require('dotenv').config();

require('./logger').install();

const mineflayer = require('mineflayer');
const { pathfinder }  = require('./pathfinder-compat');
const { goals: { GoalBlock } } = require('./pathfinder-compat');
const { plugin: movementPlugin } = require('mineflayer-movement');
const toolPlugin   = require('mineflayer-tool').plugin;
const armorManager    = require('mineflayer-armor-manager');
const autoEat         = require('mineflayer-auto-eat').loader;
const autoTotem       = require('mineflayer-totem-auto');
const { startSpectatorServer } = require('mineflayer-spectator');
const pvp             = require('mineflayer-pvp').plugin;
const minecraftHawkEye = require('minecrafthawkeye').default;
const skillEngine = require('./skill-engine');
const { installRegistryPatch, installBlockUpdateLearner, installProximityLearner, setManualOverride,
        installLoginHandshake, getModdedBlockName } = require('./registry-patch');
const db = require('./db');
const stmtRecordDig = db.prepare(`
  INSERT INTO state_ids (state_id, block_name, source, confidence, updated_at)
  VALUES (?, ?, 'digging', 'ground_truth', strftime('%s', 'now'))
  ON CONFLICT(state_id) DO UPDATE SET
    block_name = excluded.block_name,
    source     = excluded.source,
    confidence = excluded.confidence,
    updated_at = excluded.updated_at
  WHERE confidence NOT IN ('manual', 'ground_truth')
`);
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
const { buildOpenableIds, createMovements, installDoorOpener, tryUnstuck, applyServerBlockOverrides, installLavaEscapeMonitor } = require('./movement');
const { equipShield, equipBestMeleeWeapon, equipAllArmor } = require('./combat');
const { collectGrave, makeIsGrave, graveGridScan, runFarm, writeSign, wrapSignText } = require('./activities');
const { installEasyAuth } = require('./easyauth');
const { startProximityMonitor, startAutonomousBehaviors, startSkillAutonomyTicker, watchLog } = require('./monitor');
const { sessionHintFor } = require('./monitor');
const { handleNaturalCommand } = require('./commands');
const { dispatchAction, runCommand } = require('./actions');
const { getSearchContext } = require('./websearch');
const { startDiscord, attachBot, stopDiscord, toDiscord } = require('./discord-bridge');
const { saveMirrorRecording } = require('./mirror');
const { startRemoteControl, stopRemoteControl } = require('./remote-control');
const { startApi } = require('./api');
const { loadBehavior } = require('./persist');
const { syncSoul } = require('./soul');
const freyr = require('./freyr');
const { installFreyrListeners } = freyr;

const CONVERSATION_WINDOW_MS = 30000; // 30s after last interaction, no trigger needed
const PROXIMITY_CHAT_RANGE   = 12;    // blocks — within this range, no trigger needed
const NILO_SKIN_SERVER_PATH  = '/data/SerialDesignation_N-V2.png';
const SPECTATOR_PORT     = parseInt(process.env.SPECTATOR_PORT || '25566', 10);
const SPECTATOR_PASSWORD = process.env.SPECTATOR_PASSWORD || 'nilo123';

// createBot() runs again on every reconnect (bot.on('end', ...) below) — this
// module-level handle lets each run close the PREVIOUS spectator server (still
// bound to the old, dead bot) before starting a fresh one, so the port doesn't
// stay locked by a stale listener (EADDRINUSE) after the first reconnect.
let spectatorServer = null;

// ── Bot creation ──────────────────────────────────────────────────────────────

function createBot() {
  const { host, port, version, auth } = getServerConfig();
  const bot = mineflayer.createBot({
    host,
    port,
    username: BOT_USERNAME,
    version,
    auth: auth || 'offline',
    // Same fix applied to clones (clones.js) — this heavily-modded server's
    // giant declare_recipes/declare_commands/chunk packets trigger thousands
    // of PartialReadError console.log(e.stack) calls per connection from
    // protodef's FullPacketParser. hideErrors sets noErrorLogging on the
    // deserializer and kills the flood; our own bot.on('error', ...) still
    // logs concise one-line messages, so nothing useful is lost.
    hideErrors: true,
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(movementPlugin);
  bot.loadPlugin(toolPlugin);
  bot.loadPlugin(armorManager);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(autoTotem);
  bot.loadPlugin(pvp);
  bot.loadPlugin(minecraftHawkEye);

  // Spectator server — join with a real Minecraft client to watch through/near
  // Nilo in real rendering (camera-follow only, no control — see remote-control.js
  // for actual possession). Must start before login completes (registry data).
  try {
    if (spectatorServer) { try { spectatorServer.close(); } catch (_) {} }
    spectatorServer = startSpectatorServer(bot, {
      port: SPECTATOR_PORT,
      password: SPECTATOR_PASSWORD,
      spectatorsCanChat: true,
      logging: false,
    });
    console.log(`[SPECTATOR] Server available on port ${SPECTATOR_PORT} (password-protected).`);
  } catch (err) {
    console.error('[SPECTATOR] Failed to start:', err.message);
  }

  // Intercept Fabric's registry sync packet to learn modded block names
  installRegistryPatch(bot);

  // Reverse-engineered Fabric/Forge login handshake — required for the server
  // to accept this connection (see registry-patch.installLoginHandshake).
  installLoginHandshake(bot);

  // ── Login ─────────────────────────────────────────────────────────────────

  bot.on('login', () => {
    const sc = getServerConfig();
    console.log(`[NILO] Connected to ${sc.host}:${sc.port} (${sc.version}) as ${BOT_USERNAME}`);
    state.activeBotRef = bot;
    state.connectedSince = Date.now();
    state.lastConnectionError = null;
    state.reconnectAttempts = 0;
    state.pendingServerSwitch = null;
    hudApi.setBot(bot);

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

    // Door IDs are built after spawn (not login) so the server's modded block
    // registry is fully populated before we scan it.
    bot._openableIds = new Set();

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

    // Emergency lava/fire escape — interrupts pathfinding and sprints Nilo out.
    installLavaEscapeMonitor(bot);

    // Learn modded block stateIds from any block change in the world.
    installBlockUpdateLearner(bot);

    // Sample nearby stateIds while moving to feed gap-analysis over time.
    installProximityLearner(bot, state);

    // Query the server-side Fabric mod for ground-truth block names.
    // Compares against gap-analysis results and logs mismatches for diagnostics.
    installContextModLearner(bot);

    // Freyr Sword companion — intercept server UUID sync + entity tracking.
    installFreyrListeners(bot);

    // Browser views — started after spawn so the bot inventory is ready.
    bot.once('spawn', () => {
      installViewers(bot).catch(err => console.error('[VIEWER] Error:', err.message));
      // Build openable IDs here — registry-patch's spawn handler already ran (registered
      // first at line 81) and populated blocksByName with previously resolved modded doors.
      bot._openableIds = buildOpenableIds(bot);
      console.log(`[NILO] Openable blocks cached: ${bot._openableIds.size}`);

      // registry-patch fires resolveMapping 3 s after chunk discovery; refresh at 5 s so
      // newly resolved modded doors (not yet in blocksByName at spawn) get added too.
      setTimeout(() => {
        const fresh = buildOpenableIds(bot);
        let added = 0;
        for (const id of fresh) {
          if (!bot._openableIds.has(id)) {
            bot._openableIds.add(id);
            if (bot.pathfinder?.movements?.openable) bot.pathfinder.movements.openable.add(id);
            added++;
          }
        }
        if (added > 0) console.log(`[NILO] Openable blocks refreshed: +${added} (total ${bot._openableIds.size})`);
      }, 5000);
    });

    // ── Auto-follow MASTER on spawn / join ────────────────────────────────
    // entitySpawn fires when the entity enters render distance — more reliable
    // than a fixed timer because the entity may not be tracked yet at join time.
    let waitingForMasterEntity = false;

    function onMasterEntityVisible(entity) {
      if (!waitingForMasterEntity) return;
      if (entity.username !== MASTER) return;
      waitingForMasterEntity = false;
      if (state.behaviorMode !== 'idle' && state.behaviorMode !== 'wander') return;
      const dist = Math.round(bot.entity.position.distanceTo(entity.position));
      if (dist > 100) {
        console.log(`[NILO] ${MASTER} in range but too far (${dist} blocks) — staying idle.`);
        return;
      }
      console.log(`[NILO] ${MASTER} entity visible (${dist} blocks away) — following.`);
      setBehavior(bot, 'follow', MASTER);
    }

    bot.on('entitySpawn', onMasterEntityVisible);

    bot.once('spawn', () => {
      // Delayed so EasyAuth login completes first (easyauth.js sends /login on
      // server message, which fires after spawn — commands before that are dropped).
      setTimeout(() => {
        console.log(`[NILO] Applying skin: /skin set upload slim ${NILO_SKIN_SERVER_PATH}`);
        bot.chat(`/skin set upload slim ${NILO_SKIN_SERVER_PATH}`);
      }, 3000);

      // Equip best armor from inventory on spawn, and whenever inventory changes.
      setTimeout(() => equipAllArmor(bot).catch(() => {}), 2000);
      bot.on('windowClose', () => equipAllArmor(bot).catch(() => {}));
      bot.on('playerCollect', (collector) => {
        if (collector.username === bot.username)
          setTimeout(() => equipAllArmor(bot).catch(() => {}), 150);
      });

      // Start remote-control poller (BotSneakScreen in prizmo-system drives this)
      startRemoteControl(bot);

      // Restore behavior from before the reboot
      const saved = loadBehavior();

      // Restore exploringEnabled before anything else — autonomous behaviors read it.
      if (saved && typeof saved.exploringEnabled === 'boolean') {
        state.exploringEnabled = saved.exploringEnabled;
        console.log(`[NILO] Restoring exploringEnabled: ${state.exploringEnabled}`);
      }

      if (saved && saved.mode !== 'idle' && saved.mode !== 'follow') {
        console.log(`[NILO] Restoring behavior: ${saved.mode}`);
        state.behaviorMode  = saved.mode;
        state.behaviorOwner = saved.owner || null;

        if (saved.mode === 'sit') {
          bot.setControlState('sneak', true);
          state.isSneaking = true;
        } else if (saved.mode === 'wander') {
          const mv = createMovements(bot);
          bot.pathfinder.setMovements(mv);
          state.behaviorInterval = setInterval(() => {
            if (state.behaviorMode !== 'wander') return;
            const masterForWander = bot.players[MASTER]?.entity;
            if (!masterForWander || masterForWander.position.distanceTo(bot.entity.position) > 30) return;
            const pos = bot.entity.position;
            bot.pathfinder.setGoal(new GoalBlock(
              Math.floor(pos.x + (Math.random() * 20 - 10)),
              Math.floor(pos.y),
              Math.floor(pos.z + (Math.random() * 20 - 10))
            ));
          }, 5000);
        }
        // 'defensive'/'passive' → mode is set, nothing else needed.
      } else if (saved?.mode === 'follow') {
        console.log(`[NILO] Restoring behavior: follow — will resume when ${MASTER} is visible.`);
        // Leave behaviorMode as 'idle' so onMasterEntityVisible fires normally.
      } else if (saved?.mode === 'idle') {
        console.log(`[NILO] Restoring behavior: idle (stay) — suppressing auto-follow.`);
      }

      // Auto-follow: only for follow/wander restores (or fresh start with no saved state).
      // Explicit idle ('stay'), sit, defensive, passive all suppress auto-follow.
      const skipAutoFollow = saved && !['follow', 'wander'].includes(saved.mode);
      if (!skipAutoFollow) {
        waitingForMasterEntity = true;
        const existing = bot.players[MASTER]?.entity;
        if (existing) onMasterEntityVisible(existing);
      }
    });

    bot.on('playerJoined', (player) => {
      if (player.username !== MASTER) return;
      waitingForMasterEntity = true;
    });

    bot.on('playerLeft', (player) => {
      if (player.username !== MASTER) return;
      waitingForMasterEntity = false;
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

    // Packet-freeze watchdog — detects when the bot stops receiving packets
    // (e.g. after a modded particle flood corrupts the parser) and reconnects.
    let lastPacketAt = Date.now();
    bot._client.on('packet', () => { lastPacketAt = Date.now(); });
    const packetWatchdog = setInterval(() => {
      if (Date.now() - lastPacketAt > 60000) { // 60s silence = frozen
        console.warn('[NILO] Packet watchdog: no packets for 60s — forcing reconnect.');
        clearInterval(packetWatchdog);
        bot.quit('watchdog_reconnect');
      }
    }, 15000);

    // Failover watchdog (NOX only) — NOX only ever runs Nilo as a fallback
    // when Apollo (the always-on primary, GPU-backed potent model) is
    // unreachable; nilo_begin.fish already refuses to start locally if
    // Apollo answers, but nothing previously covered the case where Apollo
    // comes back WHILE NOX's fallback instance is already connected — that
    // would leave two Nilo processes fighting over the same MC account.
    // Same reachability check nilo_begin.fish uses, polled periodically.
    if (require('os').hostname() === 'NOX') {
      const failoverWatchdog = setInterval(async () => {
        try {
          const { default: fetch } = await import('node-fetch');
          const res = await fetch('http://192.168.1.101:8283/v1/agents/', {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) return;
        } catch (_) {
          return; // Apollo still unreachable — stay up
        }

        console.warn('[FAILOVER] Apollo is back online — yielding (NOX was only a fallback).');
        clearInterval(failoverWatchdog);
        state.intentionalDisconnect = true;
        try { bot.chat('Apollo is back — handing off, see you there.'); } catch (_) {}
        try { await freyr.retractBeforeDisconnect(bot); } catch (_) {}
        setTimeout(() => { bot.quit('failover_yield'); process.exit(0); }, 1000);
      }, 5 * 60 * 1000); // check every 5 minutes
    }

    // Record block names learned from actually digging — ground truth confirmation.
    // Only overwrites low-confidence/auto entries; never clobbers manual/ground_truth.
    bot.on('diggingCompleted', (block) => {
      if (!block) return;
      const sid  = block.stateId;
      const name = getModdedBlockName(sid) || block.name;
      if (!sid || !name || name === 'air' || name === 'unknown') return;
      try { stmtRecordDig.run(sid, name); }
      catch (e) { console.warn('[DIG] DB write failed:', e.message); }
    });
    console.log(`[SKILL] Engine ready. ${skillEngine.skillCount()} skill(s) loaded.`);
    attachBot(bot);

    // ── Auto-fill blank signs placed by MASTER ───────────────────────────────
    // When MASTER places a sign within 8 blocks, Letta generates text and Nilo
    // writes on it automatically.
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
          `A blank sign was just placed nearby. Write something in-character ` +
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

    const lower    = message.toLowerCase();
    const mentioned = lower.includes('nilo') || lower.startsWith('#nilo');

    // ── # prefix commands (MASTER only) — ALL commands require this prefix now.
    // Without it, nothing is command-matched — the message goes straight to
    // Letta as plain conversation. This is deliberate: casual chat that
    // happens to contain a command word ("let's follow that trail") must
    // never accidentally trigger a behavior.
    if (username === MASTER && message.startsWith('#') && !lower.startsWith('#nilo')) {
      const stripped      = message.slice(1);
      const strippedLower = stripped.toLowerCase();

      // Disconnect — also gated behind the prefix now ("#leave"/"#disconnect"/...).
      if (/\b(leave( the game)?|disconnect|log off|log out|desconecta|sai do jogo|vai embora do servidor)\b/.test(strippedLower)) {
        state.intentionalDisconnect = true;
        bot.chat('Logging off. See you later!');
        await freyr.retractBeforeDisconnect(bot);
        setTimeout(() => bot.quit(), 1000);
        return;
      }

      let acted = false;
      try { acted = await handleNaturalCommand(bot, strippedLower, stripped, username, { prefixed: true }); }
      catch (err) { console.error('[NILO] # command error:', err.message); }
      state.lastInteractionTime = Date.now();
      return;
    }

    // Drop # from non-MASTER
    if (message.startsWith('#') && !lower.startsWith('#nilo')) return;

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
      if (lower.match(/^#nilo quit\b/)) {
        bot.chat('Disconnecting...');
        await freyr.retractBeforeDisconnect(bot);
        bot.quit();
        return;
      }

      const sayMatch = message.match(/^#nilo say (.+)/i);
      if (sayMatch) { bot.chat(sayMatch[1]); return; }

      const setFarmMatch = message.match(/^#nilo setfarm (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/i);
      if (setFarmMatch) {
        const [, x1, y1, z1, x2, y2, z2] = setFarmMatch.map((v, i) => i === 0 ? v : parseInt(v));
        const cfg = loadConfig();
        cfg.farm  = { x1, y1, z1, x2, y2, z2 };
        saveConfig(cfg);
        bot.chat(`Farm area set: (${x1},${y1},${z1}) to (${x2},${y2},${z2}).`);
        return;
      }

      const setChestMatch = message.match(/^#nilo setchest (-?\d+) (-?\d+) (-?\d+)/i);
      if (setChestMatch) {
        const [, x, y, z] = setChestMatch.map((v, i) => i === 0 ? v : parseInt(v));
        const cfg = loadConfig();
        cfg.chest = { x, y, z };
        saveConfig(cfg);
        bot.chat(`Chest set at (${x},${y},${z}).`);
        return;
      }

      if (lower.match(/^#nilo farm\b/)) { runFarm(bot); return; }

      // ── Skill engine commands ─────────────────────────────────────────────

      const learnMatch = message.match(/^#nilo learn\s+(.+)/i);
      if (learnMatch) {
        if (state.skillLearnInProgress) { bot.chat('Already learning something. Give me a moment.'); return; }
        state.skillLearnInProgress = true;
        skillEngine.learnSkill(bot, learnMatch[1].trim())
          .catch(e => { console.error('[SKILL] learnSkill error:', e.message); bot.chat('Something went wrong while learning.'); })
          .finally(() => { state.skillLearnInProgress = false; });
        return;
      }

      const doMatch = message.match(/^#nilo do\s+(\S+)/i);
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

      if (lower.match(/^#nilo skills?\b/)) {
        const list   = skillEngine.listSkills();
        const chunks = list.match(/.{1,200}(?:\s|$)/g) || [list];
        for (const chunk of chunks) bot.chat(chunk.trim());
        return;
      }

      const forgetMatch = message.match(/^#nilo forget\s+(\S+)/i);
      if (forgetMatch) {
        const skillName = forgetMatch[1].trim().toLowerCase();
        const ok = skillEngine.deleteSkill(skillName);
        bot.chat(ok ? `Forgot skill: ${skillName}.` : `No skill named ${skillName}.`);
        return;
      }

      const queueMatch = message.match(/^#nilo queue\s+(.+)/i);
      if (queueMatch) {
        skillEngine.queueGoal(queueMatch[1].trim());
        bot.chat(`Added to curriculum: "${queueMatch[1].trim().slice(0, 50)}"`);
        return;
      }

      if (lower.match(/^#nilo autonomous on\b/)) {
        state.autonomousSkillsEnabled = true;
        bot.chat(`Autonomous mode ON. I will learn new skills when idle. (${skillEngine.skillCount()} skills known)`);
        return;
      }
      if (lower.match(/^#nilo autonomous off\b/)) {
        state.autonomousSkillsEnabled = false;
        bot.chat('Autonomous mode OFF.');
        return;
      }
      if (lower.match(/^#nilo autonomous\b/)) {
        bot.chat(`Autonomous mode is currently ${state.autonomousSkillsEnabled ? 'ON' : 'OFF'}. Use #nilo autonomous on/off.`);
        return;
      }

      const trustMatch = message.match(/^#nilo trust (\S+)/i);
      if (trustMatch) {
        trustPlayer(trustMatch[1]);
        bot.chat(`${trustMatch[1]} is now trusted.`);
        return;
      }

      const untrustMatch = message.match(/^#nilo (?:untrust|distrust) (\S+)/i);
      if (untrustMatch) {
        untrustPlayer(untrustMatch[1]);
        bot.chat(`${untrustMatch[1]} is no longer trusted.`);
        return;
      }

      if (lower.match(/^#nilo trusted\b/)) {
        const list = listTrusted().join(', ');
        bot.chat(list ? `Trusted: ${list}` : 'No trusted players.');
        return;
      }
    }

    // ── Behavior commands for trusted non-MASTER players ──────────────────
    if (username !== MASTER) {
      if (isTrusted(username)) {
        const masterLocked = state.behaviorOwner === MASTER;

        if (lower.match(/^#nilo follow\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          const { startFollow } = require('./movement');
          startFollow(bot, username, 2);
          bot.chat(`Following you, ${username}.`);
          return;
        }
        if (lower.match(/^#nilo stay\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'idle', username); bot.chat('Staying put.'); return;
        }
        if (lower.match(/^#nilo sit\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'sit', username); state.isSneaking = true; bot.setControlState('sneak', true); bot.chat('Sitting.'); return;
        }
        if (lower.match(/^#nilo wander\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'wander', username); bot.chat('Going for a wander.'); return;
        }
        if (lower.match(/^#nilo attack\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          const { startAttack } = require('./combat');
          startAttack(bot, username);
          return;
        }
        if (lower.match(/^#nilo defensive\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'defensive', username); bot.chat('Defensive mode.'); return;
        }
        if (lower.match(/^#nilo passive\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${state.behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'passive', username); bot.chat('Passive mode.'); return;
        }
      }
    }

    // ── Send to Letta ─────────────────────────────────────────────────────
    const cleaned = message
      .replace(/#nilo\s*/i, '')
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
      const actionHint = `[ACTIONS: if and only if the message is a direct command to move or do something physical, append [ACTION: name] at the very end — after your words, never instead of them. If no action applies, omit the tag entirely. Do not use stand as a default. Valid actions: follow, stay, sit, stop, come, closer, unstuck, dance, fish, stop_fish, bow, shoot_target, tunnel, build_house, sleep, wander, attack, guard, defensive, passive, explore, stop_explore, collect_grave, wave, spin, jump, ensure_tools, sneak, stand]`;
      const searchCtx = await getSearchContext(cleaned);
      const searchPrefix = searchCtx ? `${searchCtx}\n\n` : '';
      const ctx  = `${sessionHintFor(username)}${searchPrefix}${username} says: ${cleaned}\n[My inventory: ${inv}. Holding: ${held}. Respond in: ${lang}]\n${actionHint}`;
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
    state.isFarming = false;
    state.isLooting = false;
    state.justDied  = true;
    // Capture death position — validate it's not NaN (can happen on rapid death)
    const pos = bot.entity?.position;
    if (pos && !isNaN(pos.x) && !isNaN(pos.z)) {
      state.deathPosition = pos.clone();
      console.log(`[GRAVE] Death position saved: ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`);
    } else {
      console.warn('[GRAVE] Death position invalid — will search from respawn point');
    }
    clearBehavior(bot);
    state.behaviorMode = 'idle';
    setManualOverride(bot, 588209, 'yigd:grave');
    bot.respawn();
  });

  bot.on('spawn', async () => {
    if (!state.justDied) return;
    state.justDied = false;

    // blockUpdate listener: YIGD places the grave block as soon as the player dies.
    // If the death chunks are already loaded (nearby death), this fires immediately.
    // Unregister after first match or after collectGrave runs to avoid double-trigger.
    let graveDetected = false;
    const isGrave = makeIsGrave(bot);
    const onBlockUpdate = (_old, newBlock) => {
      if (graveDetected || !newBlock || !isGrave(newBlock)) return;
      if (!newBlock.position) return;
      graveDetected = true;
      bot.removeListener('blockUpdate', onBlockUpdate);
      console.log(`[GRAVE] Grave placed at ${newBlock.position} — auto-collecting`);
      state.deathPosition = newBlock.position.clone();
      collectGrave(bot).catch(err => console.error('[GRAVE]', err.message));
    };
    bot.on('blockUpdate', onBlockUpdate);

    // Also try after a short delay — covers the case where the grave was placed
    // before the blockUpdate listener was registered (spawn slightly after death).
    await new Promise(r => setTimeout(r, 4000));
    if (graveDetected) return; // blockUpdate already handled it
    bot.removeListener('blockUpdate', onBlockUpdate);

    console.log('[GRAVE] blockUpdate missed — scanning now...');
    await collectGrave(bot);
  });

  // ── Defensive retaliation ─────────────────────────────────────────────────

  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const RETALIATE_MODES = new Set(['defensive', 'follow', 'idle', 'wander']);
    if (!RETALIATE_MODES.has(state.behaviorMode)) return;
    const attacker = bot.nearestEntity(e =>
      e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 8
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
    state.lastConnectionError = {
      message: err.message || err.code || JSON.stringify(err),
      code:    err.code || null,
      time:    Date.now(),
    };
    console.error('[NILO] Bot error:', err.message || err.code || JSON.stringify(err));
  });

  bot.on('end', () => {
    saveMirrorRecording();
    stopRemoteControl(bot);
    state.activeBotRef = null;
    state.connectedSince = null;
    state.lastDisconnectTime = Date.now();
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
    if (state.pendingServerSwitch) {
      const sw = state.pendingServerSwitch;
      sw.attempt++;
      if (sw.attempt <= 2) {
        console.log(`[SERVER] Connecting to ${sw.targetName} (attempt ${sw.attempt}/2)...`);
        setTimeout(createBot, sw.attempt === 1 ? 0 : 2000);
      } else {
        console.log(`[SERVER] Switch to ${sw.targetName} failed after 2 attempts.`);
        deliverSwitchFailure(sw);
        state.pendingServerSwitch = null;
      }
      return;
    }
    state.reconnectAttempts++;
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

// Delivers a message when the bot itself never connected (e.g. a failed server
// switch), so bot.chat — only patched to reach the CLI after login — isn't available.
function broadcastToCli(text) {
  const payload = JSON.stringify({ type: 'nilo', text: String(text) });
  for (const ws of state.cliClients || []) {
    if (ws && ws.readyState === 1) ws.send(payload);
  }
}

function deliverSwitchFailure(sw) {
  const msg = `Hmm, something went wrong connecting to ${sw.targetName} — could you double-check the address and send it again?`;
  if (sw.replyTarget === 'discord') toDiscord(msg);
  else broadcastToCli(msg);
}

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
        // Local terminal CLI (shell access required) — treated as a dedicated
        // command console like remote-control.js's terminal channel, not
        // casual chat, so it's exempt from the # prefix requirement.
        await handleNaturalCommand(bot, message.toLowerCase(), message, MASTER, { prefixed: true });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', text: err.message }));
      }
    });

    ws.on('close', () => cliClients.delete(ws));
  });

  console.log(`[CLI] Chat session → type "nilo" in terminal`);
}

syncSoul()
  .then(parts => console.log(`[SOUL] Synced to Letta: ${parts.join(', ')}`))
  .catch(err => console.warn(`[SOUL] Sync skipped: ${err.message}`));

setActiveServer('prominence2');
const hudApi = startApi(null);
createBot();

async function shutdown(reason) {
  const bot = state.activeBotRef;
  if (bot) { try { await freyr.retractBeforeDisconnect(bot); } catch (_) {} }
  await stopDiscord(reason);
  process.exit(0);
}
process.on('SIGTERM', async () => {
  let reason = 'stop';
  try { reason = require('fs').readFileSync('/tmp/nilo_stop_reason', 'utf8').trim(); require('fs').unlinkSync('/tmp/nilo_stop_reason'); } catch (_) {}
  await shutdown(reason);
});
process.on('SIGINT',  async () => { await shutdown('stop'); });
