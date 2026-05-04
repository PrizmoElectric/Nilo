// movement.js — pathfinding helpers, door management, follow, unstuck

const { Movements, goals: { GoalBlock, GoalNear, GoalFollow } } = require('mineflayer-pathfinder');
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

// buildOpenableIds — scans the block registry once after login.
// Returns a Set<number> of block IDs for every door-like block the bot can open.
function buildOpenableIds(bot) {
  const ids = new Set();
  for (const block of Object.values(bot.registry.blocksByName || {})) {
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
  if (bot._openableIds) {
    for (const id of bot._openableIds) movements.openable.add(id);
  } else {
    for (const block of Object.values(bot.registry.blocksByName || {})) {
      if (VANILLA_IRON_DOORS.has(block.name)) continue;
      const n = block.name.toLowerCase();
      if (DOOR_KEYWORDS.some(k => n.includes(k))) movements.openable.add(block.id);
    }
  }

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
  return movements;
}

// ── Proactive door opener ─────────────────────────────────────────────────────
// mineflayer-pathfinder's built-in door-opening is known to misbehave on
// non-Paper (i.e. Fabric) servers. This handler runs every physics tick and
// opens any adjacent closed door BEFORE the pathfinder's executor reaches it,
// so the executor always finds the door already open and just walks through.

function installDoorOpener(bot) {
  const openableIds = bot._openableIds; // built once in login handler
  const lastAttempt = new Map();        // blockPos key → timestamp, prevents spam

  bot.on('physicsTick', () => {
    // Use goal presence instead of isMoving() — isMoving() returns false while
    // the pathfinder is replanning, which is exactly when the bot is blocked by
    // a closed door and needs the opener to fire.
    if (!bot.pathfinder.goal) return;

    const pos = bot.entity.position;
    // Check all adjacent positions at foot and eye level, plus the bot's own
    // block (handles the case where physics pushed the bot into the door space).
    const offsets = [
      [0,0,0],[0,1,0],
      [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
      [1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
    ];

    for (const [ox, oy, oz] of offsets) {
      const block = bot.blockAt(pos.offset(ox, oy, oz));
      if (!block || !openableIds.has(block.type)) continue;

      // Only act on CLOSED doors (open doors have open=true/open='true')
      const props = block.getProperties ? block.getProperties() : {};
      if (props.open === true || props.open === 'true') continue;

      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      const now = Date.now();
      if (now - (lastAttempt.get(key) || 0) < 800) continue; // 0.8s cooldown per block

      lastAttempt.set(key, now);
      console.log(`[NILO] Opening door: ${block.name} at ${block.position}`);
      bot.activateBlock(block).catch(err => console.log('[NILO] Door open failed:', err.message));
      break; // open one door per tick max
    }
  });
}

// ── Follow ────────────────────────────────────────────────────────────────────
// Uses GoalFollow (pathfinder dynamic goal) — continuously recalculates as the
// entity moves and handles all terrain. A 1-second refresh re-acquires the
// entity handle and adjusts distance.

function startFollow(bot, targetUsername, distance = 2) {
  setBehavior(bot, 'follow', targetUsername);
  bot.pathfinder.setMovements(createMovements(bot));

  function setFollowGoal() {
    if (state.behaviorMode !== 'follow') { clearInterval(followInterval); return; }
    const target = bot.players[targetUsername]?.entity;
    if (!target) { bot.clearControlStates(); return; }
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
  clearBehavior(bot);
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

module.exports = {
  buildOpenableIds, createMovements, installDoorOpener,
  startFollow, tryUnstuck, applyServerBlockOverrides,
};
