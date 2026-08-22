// monitor.js — proximity/health monitor, autonomous behaviors, skill ticker, log watcher

const fs       = require('fs');
const readline = require('readline');
const skillEngine = require('./skill-engine');
const state    = require('./state');
const { setBehavior } = require('./behavior');
const { createMovements } = require('./movement');
const { isHostileMob, startAssist } = require('./combat');
const { queryLetta, parseAction, chatLong } = require('./letta');
const { MASTER, BOT_USERNAME, DEATH_VERBS, ADVANCEMENT_RE, getServerConfig } = require('./config');
const { goals: { GoalBlock, GoalNear } } = require('./pathfinder-compat');
const db = require('./db');
const { getModdedBlockName } = require('./registry-patch');
const freyr = require('./freyr');
const { clones } = require('./clones');

// Persistent set of block positions that failed openContainer (survives restarts).
// Stored as "x,y,z" keys. Populated from DB on first load, written back on new failures.
const failedContainers = (() => {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS failed_containers (pos TEXT PRIMARY KEY, block_name TEXT, failed_at INTEGER)`).run();
    const rows = db.prepare('SELECT pos FROM failed_containers').all();
    return new Set(rows.map(r => r.pos));
  } catch (_) { return new Set(); }
})();

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
  let lastFollowComplaintTime = 0;
  let lastThreatWarnTime      = 0;
  let knownThreats            = new Set(); // entity IDs seen this threat cycle
  const RANGE                    = 15;
  const LOW_HEALTH               = 8; // out of 20
  const THREAT_RANGE             = 16;
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
          isHostileMob(e) && e.position && e.position.distanceTo(bot.entity.position) < THREAT_RANGE
        );
        const newThreats = nearbyHostiles.filter(e => !knownThreats.has(e.id));
        if (newThreats.length > 0) {
          // Auto-engage: switch to assist mode so Nilo fights instead of just watching.
          startAssist(bot, MASTER);
          if (now2 - lastThreatWarnTime >= THREAT_WARN_COOLDOWN_MS) {
            lastThreatWarnTime = now2;
            const names = [...new Set(newThreats.map(e => e.name))].join(', ');
            queryLetta(
              `${sessionHintFor(MASTER)}[THREAT EVENT] You just spotted hostile mob(s) nearby: ${names}. React briefly — a quick warning or tense observation.\n[Respond in: en]`
            ).then(r => { const { text: t } = parseAction(r); if (t) chatLong(bot, t); }).catch(() => {});
          }
        }
        knownThreats = new Set(nearbyHostiles.map(e => e.id));
      }
    }

    // ── Proximity check ───────────────────────────────────────────────────
    if (!entity) { wasInRange = false; return; }

    const dist  = entity.position.distanceTo(bot.entity.position);
    const inRange = dist <= RANGE;
    const now   = Date.now();

    if (inRange && !wasInRange) wasInRange = true;

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

  const CONTAINER_KEYWORDS = ['chest', 'barrel', 'crate', 'storage', 'bin', 'locker', 'safe', 'cabinet', 'trunk', 'box', 'vault', 'strongbox'];
  // cable_bus / terminal / interface removed — those are AE2 parts, not openable by bot.openContainer

  let lookCooldown    = 0;
  let exploreCooldown = 0;

  // ── Stray Freyr Sword scan ────────────────────────────────────────────────
  // Clones that die or disconnect without going through retractBeforeDisconnect
  // leave their summoned sword stranded in the world, bound to a UUID that
  // outlives them. Every ~30s, look for nearby freyr_sword_entity that aren't
  // Nilo's own and don't belong to any currently-online clone — log the find
  // once per UUID so it doesn't spam, but don't chat about it (housekeeping).
  let strayScanCooldown = 0;
  const seenStrayUUIDs  = new Set();

  state.autonomousInterval = setInterval(async () => {
    if (strayScanCooldown > 0) {
      strayScanCooldown--;
    } else {
      strayScanCooldown = 15; // ~30s at 2s/tick
      try {
        const onlineCloneUUIDs = [...clones.values()].map(c => freyr.getFreyrUUID(c));
        const strays = freyr.findStraySwords(bot, onlineCloneUUIDs);
        for (const e of strays) {
          if (seenStrayUUIDs.has(e.uuid)) continue;
          seenStrayUUIDs.add(e.uuid);
          const p = e.position;
          console.log(`[FREYR] Stray sword spotted at (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}) — uuid=${e.uuid} (likely left behind by a clone that died or disconnected).`);
        }
        // Forget UUIDs that are no longer nearby — lets a sword be re-flagged
        // if it reappears later (e.g. after a chunk reload).
        const stillNearby = new Set(strays.map(e => e.uuid));
        for (const uuid of seenStrayUUIDs) if (!stillNearby.has(uuid)) seenStrayUUIDs.delete(uuid);
      } catch (_) {}
    }

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

    // Check for nearby containers (vanilla + modded — matched by name keywords)
    const chestBlock = bot.findBlock({
      matching: b => {
        if (!b) return false;
        let name = (b.name || '').toLowerCase();
        if (!name && b.stateId != null) name = (getModdedBlockName(b.stateId) || '').toLowerCase();
        if (!name || name === 'unknown') return false;
        if (!CONTAINER_KEYWORDS.some(kw => name.includes(kw))) return false;
        if (b.position) {
          const key = `${b.position.x},${b.position.y},${b.position.z}`;
          if (failedContainers.has(key)) return false;
        }
        return true;
      },
      maxDistance: 24,
    });

    if (chestBlock) {
      state.isLooting = true;
      const key = `${chestBlock.position.x},${chestBlock.position.y},${chestBlock.position.z}`;
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
          `[AUTONOMOUS] While exploring you found and opened a ${chestBlock.name} at (${p.x},${p.y},${p.z}). ` +
          `Contents: ${preview}. React briefly in character — curiosity, excitement, or disappointment.\n[Respond in: en]`
        );
        const { text: chestText } = parseAction(response);
        if (chestText) await chatLong(bot, chestText);
      } catch (err) {
        console.error(`[NILO] Container open failed (${chestBlock.name}): ${err.message}`);
        failedContainers.add(key); // persistent — won't retry this block in future sessions
        try { db.prepare('INSERT OR IGNORE INTO failed_containers (pos, block_name, failed_at) VALUES (?,?,?)').run(key, chestBlock.name, Math.floor(Date.now()/1000)); } catch (_) {}
      }
      // Only clear isLooting if a manual command hasn't taken over
      if (!state.manualInteractLock) state.isLooting = false;
      return;
    }

    // No chest nearby — wander, but only if MASTER is online and close enough.
    // Without this guard Nilo drifts unboundedly and dies far from base.
    const masterForWander = bot.players[MASTER]?.entity;
    if (!masterForWander || masterForWander.position.distanceTo(bot.entity.position) > 30) return;

    const pos = bot.entity.position;
    const rx  = pos.x + (Math.random() * 20 - 10);
    const rz  = pos.z + (Math.random() * 20 - 10);
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

function handleLogEvent(_payload) {
  // Automatic responses to server log events (deaths, advancements) disabled.
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
