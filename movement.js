// movement.js — pathfinding helpers, door management, follow, unstuck

const { Movements, goals: { GoalBlock, GoalNear, GoalFollow } } = require('./pathfinder-compat');
const state    = require('./state');
const { setBehavior, clearBehavior } = require('./behavior');

// This server uses pumpkin/melon stem blocks as decorative floor tiles (the mod
// retextures them to look like tiled stone and adds a speed bonus). In minecraft-data
// these have boundingBox:'empty' (passable), so mineflayer thinks the bot falls
// through them while the server treats them as solid — causing constant position
// correction jitter. Patching to 'block' makes pathfinder and physics agree with
// the server.
const SERVER_FLOOR_TILES = [
  'pumpkin_stem', 'attached_pumpkin_stem',
  'melon_stem',   'attached_melon_stem',
];

function applyServerBlockOverrides(bot) {
  for (const name of SERVER_FLOOR_TILES) {
    const block = bot.registry.blocksByName[name];
    if (block) block.boundingBox = 'block';
  }
  console.log('[NILO] Server floor tile overrides applied (pumpkin/melon stems → solid).');
}

// ── Door / openable block constants ──────────────────────────────────────────

// VANILLA_IRON_DOORS — only these two require redstone; all others can be pushed open.
const VANILLA_IRON_DOORS = new Set(['iron_door', 'iron_trapdoor']);

// DOOR_KEYWORDS — block-name substrings that identify openable door-like blocks.
// Covers vanilla + common modded naming patterns (Macaw's, Quark, Farmer's Delight…).
const DOOR_KEYWORDS = ['door', 'trapdoor', 'gate', 'hatch', 'shutter', 'portcullis', 'wicket', 'flap'];

// buildOpenableIds — scans the block registry once after spawn (not login, so
// modded block registrations from the server are present).
// Matches blocks two ways: name keywords AND an 'open' state property (which all
// door/gate/trapdoor blocks have, vanilla and modded alike).
function buildOpenableIds(bot) {
  const ids = new Set();

  // Pass 1: vanilla registry (bot.registry.blocks = numeric array, 35 vanilla blocks).
  const entries = Array.isArray(bot.registry.blocks)
    ? bot.registry.blocks
    : Object.values(bot.registry.blocks || {});

  for (const block of entries) {
    if (!block || !block.name) continue;
    if (VANILLA_IRON_DOORS.has(block.name)) continue;
    const n = block.name.toLowerCase();
    if (DOOR_KEYWORDS.some(k => n.includes(k))) { ids.add(block.id); continue; }
    if (block.states?.some(s => s.name === 'open')) ids.add(block.id);
  }

  // Pass 2: bot.registry.blocksByName — registry-patch populates this with previously
  // resolved modded blocks (e.g. mcwdoors:oak_door) during spawn, before this function
  // is called. Modded descriptors always have states:[] so we rely on name keywords only.
  for (const block of Object.values(bot.registry.blocksByName || {})) {
    if (!block || !block.name || ids.has(block.id)) continue;
    if (VANILLA_IRON_DOORS.has(block.name)) continue;
    const n = block.name.toLowerCase();
    if (DOOR_KEYWORDS.some(k => n.includes(k))) ids.add(block.id);
  }

  return ids;
}

// Substrings that identify blocks which should NEVER be in the fences set —
// they're full 1×1×1 blocks whose minStateId shape is misleadingly > 1 block
// (e.g. a decorative top, an arm in the default wall state, etc.).
const FENCE_SAFE_PATTERNS = [
  'stone_brick', 'stonebrick', 'cobblestone', 'mossy', 'cracked',
  'polished', 'smooth', 'chiseled', 'cut_', 'deepslate', 'blackstone',
  'basalt', 'granite', 'diorite', 'andesite', 'calcite', 'tuff',
  'sandstone', 'red_sandstone', 'prismarine', 'end_stone',
  'nether_brick', 'quartz', 'purpur', 'terracotta',
];
// These always stay in fences even if the above patterns match.
const FENCE_KEEP_PATTERNS = ['fence', 'wall', 'bar', 'pane', 'grate', 'trellis'];

// createMovements — standard Movements with door/gate/trapdoor opening enabled.
// Block breaking is OFF by default. Pass { canDig: true } to allow it.
function createMovements(bot, opts = {}) {
  const movements = new Movements(bot);

  // Let pathfinder PLAN routes that pass through doors (it marks openable blocks
  // as walkable in the cost graph). Actual door-opening is handled by the
  // proactive door opener below — this flag just enables the path planning.
  movements.canOpenDoors = true;

  // Populate openable with all door-like blocks the bot can interact with.
  // bot._openableIds is built at spawn and includes modded doors via state inspection.
  for (const id of (bot._openableIds || [])) movements.openable.add(id);

  // ── Fences set cleanup ────────────────────────────────────────────────────
  // The pathfinder builds `fences` by checking each block's minStateId shape.
  // Modded stone/brick blocks often have decorative tops or wall-post default
  // states that push shapes[0][4] > 1, landing them in `fences` and making
  // them completely impassable. Remove the obvious false-positives.
  let fencesRemoved = 0;
  for (const id of [...movements.fences]) {
    const block = bot.registry.blocks[id];
    if (!block) continue;
    const n = block.name.toLowerCase();
    if (
      FENCE_SAFE_PATTERNS.some(p => n.includes(p)) &&
      !FENCE_KEEP_PATTERNS.some(p => n.includes(p))
    ) {
      movements.fences.delete(id);
      fencesRemoved++;
    }
  }
  if (fencesRemoved > 0) {
    console.log(`[NILO] Removed ${fencesRemoved} stone/brick block(s) from fences set.`);
  }

  // Remove server floor tiles from fences — they're solid floor, not obstacles.
  for (const name of SERVER_FLOOR_TILES) {
    const b = bot.registry.blocksByName[name];
    if (b) movements.fences.delete(b.id);
  }

  movements.canDig = opts.canDig === true;

  // Explicitly mark lava as avoid — pathfinder avoids walking IN it by default
  // but does not treat adjacent lava as dangerous. This raises the cost so the
  // planner finds routes that stay away from lava edges.
  for (const name of ['lava', 'flowing_lava']) {
    const b = bot.registry.blocksByName[name];
    if (b) movements.blocksToAvoid.add(b.id);
  }

  return movements;
}

// ── Proactive door opener ─────────────────────────────────────────────────────
// mineflayer-pathfinder's built-in door-opening is known to misbehave on
// non-Paper (i.e. Fabric) servers. This handler runs every physics tick and
// opens any adjacent closed door BEFORE the pathfinder's executor reaches it,
// so the executor always finds the door already open and just walks through.

// scanDoorContext — logs the 3×5×3 column around a door so we can see
// if the path is through a gap, a wall, or a corridor.
function scanDoorContext(bot, doorPos) {
  const lines = [];
  for (let y = doorPos.y + 2; y >= doorPos.y - 2; y--) {
    const row = [];
    for (let dz = -1; dz <= 1; dz++) {
      const cells = [];
      for (let dx = -1; dx <= 1; dx++) {
        const b = bot.blockAt(doorPos.offset(dx, y - doorPos.y, dz));
        const n = b ? (b.name === 'air' ? '.' : b.name.replace(/^.*:/, '').slice(0, 8)) : '?';
        cells.push(n.padEnd(8));
      }
      row.push(cells.join(' '));
    }
    lines.push(`  y=${y}: ${row.join(' | ')}`);
  }
  return lines.join('\n');
}

function installDoorOpener(bot) {
  const openableIds = bot._openableIds; // built once in login handler
  const lastAttempt = new Map();        // blockPos key → timestamp, prevents spam
  let navLogTimer   = null;

  // Periodic navigation logger — fires every 2 s while pathfinder has a goal.
  function startNavLog() {
    if (navLogTimer) return;
    navLogTimer = setInterval(() => {
      if (!bot.pathfinder.goal) { clearInterval(navLogTimer); navLogTimer = null; return; }
      const p = bot.entity.position;
      const g = bot.pathfinder.goal;
      const gx = g.x ?? '?'; const gy = g.y ?? '?'; const gz = g.z ?? '?';
      const dist = (typeof g.x === 'number')
        ? Math.round(p.distanceTo({ x: gx, y: gy, z: gz }))
        : '?';
      console.log(`[NAV] pos=(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) → goal=(${gx},${gy},${gz}) dist=${dist}`);
    }, 2000);
  }

  let physDiagTimer = 0;
  bot.on('physicsTick', () => {
    // Periodic block-physics diagnostic while following — logs what's at Nilo's feet/head
    if (bot.pathfinder.goal && ++physDiagTimer % 100 === 0) {
      const p = bot.entity.position;
      const feet = bot.blockAt(p.offset(0, 0, 0));
      const head = bot.blockAt(p.offset(0, 1, 0));
      const floor = bot.blockAt(p.offset(0, -1, 0));
      const fmt = b => b ? `${b.name||'?'}(bb=${b.boundingBox},sh=${b.shapes?.length})` : 'null';
      console.log(`[PHYSICS] pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) floor=${fmt(floor)} feet=${fmt(feet)} head=${fmt(head)}`);
    }

    if (!bot.pathfinder.goal) return;
    startNavLog();

    const pos = bot.entity.position;
    const offsets = [
      // Same block (bot walked into it) + eye level
      [0,0,0],[0,1,0],
      // Cardinal 1-block
      [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
      [1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
      // Diagonal 1-block (e.g. door at (-1,0,-1) from bot at (0,0,0))
      [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
      [1,1,1],[-1,1,1],[1,1,-1],[-1,1,-1],
      // Cardinal 2-block lookahead
      [2,0,0],[-2,0,0],[0,0,2],[0,0,-2],
      [2,1,0],[-2,1,0],[0,1,2],[0,1,-2],
    ];

    for (const [ox, oy, oz] of offsets) {
      const block = bot.blockAt(pos.offset(ox, oy, oz));
      if (!block) continue;

      const props = block.getProperties ? block.getProperties() : {};

      const knownDoor   = openableIds.has(block.type);
      const runtimeDoor = !knownDoor && ('open' in props) && !VANILLA_IRON_DOORS.has(block.name);

      // Log any door-like block (open or closed) so we can see what Nilo sees.
      if (knownDoor || runtimeDoor) {
        const bpos = block.position;
        const logKey = `seen:${bpos.x},${bpos.y},${bpos.z}`;
        if (!lastAttempt.has(logKey) || Date.now() - lastAttempt.get(logKey) > 5000) {
          lastAttempt.set(logKey, Date.now());
          const isOpen = props.open === true || props.open === 'true';
          console.log(`[DOOR] ${isOpen ? 'open' : 'CLOSED'} "${block.name}" at (${bpos.x},${bpos.y},${bpos.z}) ` +
            `type=${block.type} known=${knownDoor} runtime=${runtimeDoor} | ` +
            `Nilo at (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)})`);
          if (!isOpen) console.log('[DOOR] Context:\n' + scanDoorContext(bot, bpos));
        }
      }

      // Skip already-open doors. If the block has no state info (states:[]),
      // props.open is undefined — we can't distinguish open from closed, so we
      // always attempt activation but use a longer cooldown (8 s) to avoid
      // toggling the door shut before the bot walks through.
      const knowsOpenState = 'open' in props;
      if (props.open === true || props.open === 'true') continue;
      if (!knownDoor && !runtimeDoor) continue;

      if (runtimeDoor) {
        openableIds.add(block.type);
        if (bot.pathfinder.movements?.openable) {
          bot.pathfinder.movements.openable.add(block.type);
        }
        if (bot.pathfinder.goal) {
          const goal = bot.pathfinder.goal;
          bot.pathfinder.setGoal(null);
          bot.pathfinder.setGoal(goal, true);
        }
        console.log(`[DOOR] Runtime-learned type=${block.type} ("${block.name}") — added to openable, replanning`);
      }

      const bpos    = block.position;
      const key     = `${bpos.x},${Math.floor(bpos.y / 2)},${bpos.z}`;
      const now     = Date.now();
      const cooldown = knowsOpenState ? 3000 : 8000; // longer when we can't read open state
      if (now - (lastAttempt.get(key) || 0) < cooldown) continue;

      lastAttempt.set(key, now);
      console.log(`[DOOR] Activating "${block.name}" at (${bpos.x},${bpos.y},${bpos.z}) knowsState=${knowsOpenState}`);
      bot.activateBlock(block)
        .then(() => console.log(`[DOOR] Activated OK`))
        .catch(err => console.log(`[DOOR] Activate failed: ${err.message}`));
      break;
    }
  });
}

// ── Collect block ─────────────────────────────────────────────────────────────
// Replaces mineflayer-collectblock's bot.collectBlock.collect(): that plugin
// builds goals from its own internally-bundled copy of the OLD
// mineflayer-pathfinder and calls bot.pathfinder.movements.safeToBreak(block),
// neither of which pathfinder-compat.js implements — it throws immediately
// against the new engine. Same walk-there-then-dig pattern "mine this"
// (commands/activities.js) already uses successfully.
async function collectBlock(bot, block) {
  const p = block.position;
  bot.pathfinder.setMovements(createMovements(bot));
  await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));

  const freshBlock = bot.blockAt(p);
  if (!freshBlock || freshBlock.name === 'air') return;

  if (bot.tool?.equipForBlock) {
    try { await bot.tool.equipForBlock(freshBlock); } catch (_) {}
  }
  await bot.dig(freshBlock, true);
}

// ── Follow ────────────────────────────────────────────────────────────────────
// Uses GoalFollow (pathfinder dynamic goal) — continuously recalculates as the
// entity moves and handles all terrain. A 1-second refresh re-acquires the
// entity handle and adjusts distance.

function startFollow(bot, targetUsername, distance = 2) {
  if (!setBehavior(bot, 'follow', targetUsername)) return;
  bot.pathfinder.setMovements(createMovements(bot));

  function setFollowGoal() {
    if (state.behaviorMode !== 'follow') { clearInterval(followInterval); return; }
    const target = bot.players[targetUsername]?.entity;
    if (!target) { bot.clearControlStates(); return; }
    const dist = bot.entity.position.distanceTo(target.position);
    if (dist > 100) {
      bot.chat(`/tp ${bot.username} ${targetUsername}`);
      return;
    }
    bot.pathfinder.setGoal(new GoalFollow(target, distance), true);
  }

  setFollowGoal(); // set immediately
  const followInterval = setInterval(setFollowGoal, 1000);

  function cleanup() {
    clearInterval(followInterval);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }

  state.behaviorInterval = { _cleanup: cleanup };
}

// ── Unstuck ───────────────────────────────────────────────────────────────────

async function tryUnstuck(bot) {
  // Pause pathfinding but do NOT clear the behavior — the follow/wander interval
  // will re-set the goal within 1s once we're done, so behavior resumes automatically.
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();

  const startPos = bot.entity.position.clone();

  // Phase 1: raw controls — bypasses pathfinder, works even when wedged in blocks
  const tries = [
    { forward: true, jump: true },
    { back:    true, jump: true },
    { left:    true, jump: true },
    { right:   true, jump: true },
    { forward: true             },
    { back:    true             },
    { left:    true             },
    { right:   true             },
    {                jump: true },
  ];

  for (const controls of tries) {
    bot.clearControlStates();
    for (const [k, v] of Object.entries(controls)) bot.setControlState(k, v);
    await new Promise(r => setTimeout(r, 500));
    bot.clearControlStates();
    if (bot.entity.position.distanceTo(startPos) > 0.5) {
      console.log('[NILO] Unstuck via raw movement.');
      return true;
    }
  }

  // Phase 2: pathfinder without digging — tries nearby positions in all directions
  bot.pathfinder.setMovements(createMovements(bot));

  const p = bot.entity.position;
  const candidates = [
    [5,0,0], [-5,0,0], [0,0,5], [0,0,-5],
    [4,1,0], [-4,1,0], [0,1,4], [0,1,-4],
    [3,0,3], [-3,0,-3], [3,0,-3], [-3,0,3],
    [0,2,0],
  ];

  for (const [ox, oy, oz] of candidates) {
    try {
      await bot.pathfinder.goto(new GoalBlock(
        Math.floor(p.x + ox),
        Math.floor(p.y + oy),
        Math.floor(p.z + oz)
      ));
      if (bot.entity.position.distanceTo(startPos) > 1) {
        console.log('[NILO] Unstuck via pathfinder.');
        return true;
      }
    } catch (_) {}
  }

  console.log('[NILO] Unstuck: could not escape.');
  return false;
}

const Vec3 = require('vec3');

const DANGEROUS = new Set(['lava', 'flowing_lava', 'fire', 'soul_fire']);

function isDangerous(b) {
  return b && DANGEROUS.has(b.name);
}

// Compute a unit repulsion vector pointing away from all nearby lava/fire blocks.
// Each dangerous block contributes a force proportional to 1/distance².
// Returns null if no dangerous blocks are nearby.
function lavaRepulsionVector(bot, radius = 6) {
  const pos = bot.entity.position;
  let rx = 0, rz = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (!isDangerous(b)) continue;
        const dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 === 0) continue;
        rx -= dx / dist2;  // push AWAY: subtract the delta toward the block
        rz -= dz / dist2;
      }
    }
  }
  const mag = Math.sqrt(rx * rx + rz * rz);
  if (mag < 0.001) return null;
  return { x: rx / mag, z: rz / mag };
}

// Find the nearest safe standing block in a given horizontal direction.
// Searches increasing distances along (dirX, dirZ), scans ±3 vertically.
function findSafeTarget(bot, dirX, dirZ, maxDist = 10) {
  const pos = bot.entity.position;
  for (let d = 2; d <= maxDist; d++) {
    const tx = Math.floor(pos.x + dirX * d);
    const tz = Math.floor(pos.z + dirZ * d);
    for (let dy = 2; dy >= -4; dy--) {
      const ty    = Math.floor(pos.y) + dy;
      const floor = bot.blockAt(new Vec3(tx, ty, tz));
      const space1 = bot.blockAt(new Vec3(tx, ty + 1, tz));
      const space2 = bot.blockAt(new Vec3(tx, ty + 2, tz));
      if (floor  && floor.boundingBox  === 'block' && !isDangerous(floor) &&
          space1 && space1.boundingBox !== 'block' && !isDangerous(space1) &&
          space2 && space2.boundingBox !== 'block' && !isDangerous(space2)) {
        return new Vec3(tx, ty + 1, tz);
      }
    }
  }
  return null;
}

// installLavaEscapeMonitor — when Nilo is on fire or in lava, immediately
// stops all navigation and sprints toward the direction of least lava density
// (repulsion vector), then pathfinds to the nearest safe block in that direction.
function installLavaEscapeMonitor(bot) {
  let escaping = false;

  bot.on('physicsTick', () => {
    if (escaping) return;
    const pos  = bot.entity.position;
    const feet = bot.blockAt(pos);
    const head = bot.blockAt(pos.offset(0, 1, 0));

    if (!bot.entity.onFire && !isDangerous(feet) && !isDangerous(head)) return;

    escaping = true;
    console.warn('[NILO] In lava/on fire — computing escape direction');

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const dir = lavaRepulsionVector(bot) ?? { x: 0, z: 1 }; // fallback: north
    const target = findSafeTarget(bot, dir.x, dir.z);

    if (target) {
      console.warn(`[NILO] Lava escape → ${target}`);
      const { GoalBlock } = require('./pathfinder-compat').goals;
      const mvs = createMovements(bot);
      bot.pathfinder.setMovements(mvs);
      bot.pathfinder.setGoal(new GoalBlock(target.x, target.y, target.z));
    } else {
      // No safe block found — force jump while facing escape direction
      console.warn('[NILO] No safe target found, jumping in repulsion direction');
      bot.look(Math.atan2(-dir.x, -dir.z), 0, true).then(() => {
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        setTimeout(() => {
          bot.clearControlStates();
          if (state.isSneaking) bot.setControlState('sneak', true);
        }, 600);
      });
    }

    setTimeout(() => { escaping = false; }, 2000);
  });
}

module.exports = {
  buildOpenableIds, createMovements, installDoorOpener,
  startFollow, tryUnstuck, applyServerBlockOverrides,
  installLavaEscapeMonitor, collectBlock,
};
