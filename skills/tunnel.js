// tunnel.js — tunnel mining in MASTER's look direction
//
// Digs a 1-wide 2-tall tunnel forward. Handles:
//   - Lava: seals all adjacent lava faces before breaking a block
//   - Water: seals flowing/source water that would flood the tunnel
//   - Torches: placed every 8 blocks on left wall (or floor as fallback)
//   - Falling blocks: sand/gravel above head gets dug before advancing
//   - Health abort: stops if health <= 4
//
// Commands (wired in commands.js):
//   "dig a tunnel", "mine forward", "tunnel [N]", "bore a tunnel"
//   "stop tunneling", "stop digging", "stop mining"

const Vec3  = require('vec3');
const { goals: { GoalBlock } } = require('mineflayer-pathfinder');
const state = require('../state');
const { setBehavior, clearBehavior } = require('../behavior');
const { createMovements } = require('../movement');
const { MASTER } = require('../config');

const DEFAULT_LENGTH   = 32;
const TORCH_INTERVAL   = 8;   // place a torch every N blocks
const FALLING_BLOCKS   = new Set(['sand','red_sand','gravel','concrete_powder',
  'white_concrete_powder','orange_concrete_powder','magenta_concrete_powder',
  'light_blue_concrete_powder','yellow_concrete_powder','lime_concrete_powder',
  'pink_concrete_powder','gray_concrete_powder','light_gray_concrete_powder',
  'cyan_concrete_powder','purple_concrete_powder','blue_concrete_powder',
  'brown_concrete_powder','green_concrete_powder','red_concrete_powder',
  'black_concrete_powder']);
const DANGEROUS_FLUIDS = new Set(['lava', 'flowing_lava']);
const ALL_FLUIDS       = new Set(['lava','flowing_lava','water','flowing_water']);

// ── Direction helpers ─────────────────────────────────────────────────────────

// Snap a mineflayer yaw to the nearest cardinal direction vector.
// mineflayer yaw: 0 = south (+Z), π/2 = west (-X), π = north (-Z), 3π/2 = east (+X)
function yawToCardinal(yaw) {
  const n = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (n < Math.PI / 4 || n >= 7 * Math.PI / 4) return new Vec3(0, 0, 1);   // south
  if (n < 3 * Math.PI / 4)                       return new Vec3(-1, 0, 0);  // west
  if (n < 5 * Math.PI / 4)                       return new Vec3(0, 0, -1);  // north
  return                                                 new Vec3(1, 0, 0);   // east
}

function dirName(dir) {
  if (dir.z ===  1) return 'south';
  if (dir.z === -1) return 'north';
  if (dir.x ===  1) return 'east';
  return 'west';
}

// Left-perpendicular of a horizontal direction (for torch wall placement)
function leftOf(dir) { return new Vec3(-dir.z, 0, dir.x); }

// ── Tool helpers ──────────────────────────────────────────────────────────────

function getBestPickaxe(bot) {
  const priority = [
    'netherite_pickaxe','diamond_pickaxe','iron_pickaxe',
    'stone_pickaxe','wooden_pickaxe','golden_pickaxe',
  ];
  for (const name of priority) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) return item;
  }
  return bot.inventory.items().find(i => i.name.includes('pickaxe')) ?? null;
}

function getSealBlock(bot) {
  return bot.inventory.items().find(i =>
    ['cobblestone','stone','dirt','netherrack','gravel','sand','andesite',
     'diorite','granite','deepslate'].some(k => i.name.includes(k))
  ) ?? null;
}

function getTorch(bot) {
  return bot.inventory.items().find(i =>
    i.name === 'torch' || i.name === 'soul_torch' ||
    (i.name.includes('torch') && !i.name.includes('torchflower'))
  ) ?? null;
}

// ── Hazard sealing ────────────────────────────────────────────────────────────

// Before breaking `targetBlock`, plug any adjacent dangerous fluid faces
// by placing a solid block into them from the target's face.
async function sealAdjacent(bot, targetBlock, fluidSet) {
  if (!targetBlock) return;
  const seal = getSealBlock(bot);
  if (!seal) return;

  const faces = [
    new Vec3(1,0,0), new Vec3(-1,0,0),
    new Vec3(0,1,0), new Vec3(0,-1,0),
    new Vec3(0,0,1), new Vec3(0,0,-1),
  ];

  for (const face of faces) {
    const nb = bot.blockAt(targetBlock.position.plus(face));
    if (!nb || !fluidSet.has(nb.name)) continue;
    try {
      await bot.equip(seal, 'hand');
      await bot.placeBlock(targetBlock, face);
      console.log(`[TUNNEL] Sealed ${nb.name} at ${nb.position}`);
    } catch (err) {
      console.error('[TUNNEL] Seal error:', err.message);
    }
  }
}

// ── Torch placement ───────────────────────────────────────────────────────────

async function placeTorch(bot, pos, dir) {
  const torch = getTorch(bot);
  if (!torch) return;

  const left = leftOf(dir);
  // Try: left wall, right wall, then floor
  const candidates = [
    { wallPos: pos.plus(left),         face: left.scaled(-1)    },
    { wallPos: pos.minus(left),        face: left               },
    { wallPos: pos.offset(0, -1, 0),   face: new Vec3(0, 1, 0)  },
  ];

  for (const { wallPos, face } of candidates) {
    const wallBlock = bot.blockAt(wallPos);
    if (!wallBlock || wallBlock.boundingBox === 'empty') continue;
    try {
      await bot.equip(torch, 'hand');
      await bot.placeBlock(wallBlock, face);
      return;
    } catch (_) {}
  }
}

// ── Block breaking ────────────────────────────────────────────────────────────

// Safely dig a single block: seal hazards first, then break.
async function safeDig(bot, pos, pickaxe) {
  const block = bot.blockAt(pos);
  if (!block) return;
  if (block.name === 'air' || block.name === 'cave_air') return;
  if (block.boundingBox === 'empty' && !ALL_FLUIDS.has(block.name)) return; // already clear

  // Seal dangerous fluids adjacent to this block before we expose them
  await sealAdjacent(bot, block, DANGEROUS_FLUIDS);
  // Also seal water that would flood in
  await sealAdjacent(bot, block, new Set(['water', 'flowing_water']));

  // Re-equip pickaxe (sealing may have changed held item)
  const pick = pickaxe ?? getBestPickaxe(bot);
  if (pick) {
    try { await bot.equip(pick, 'hand'); } catch (_) {}
  }

  const freshBlock = bot.blockAt(pos);
  if (!freshBlock || freshBlock.name === 'air' || freshBlock.name === 'cave_air') return;
  if (ALL_FLUIDS.has(freshBlock.name)) return; // sealed, now a solid block — re-check next loop

  try {
    await bot.dig(freshBlock, true); // true = force dig even if not looking at it
  } catch (err) {
    if (!err.message?.includes('already')) {
      console.error(`[TUNNEL] Dig error at ${pos}: ${err.message}`);
    }
  }
}

// ── Forward movement ──────────────────────────────────────────────────────────

async function stepForward(bot, targetPos) {
  try {
    const mv = createMovements(bot);
    bot.pathfinder.setMovements(mv);
    await bot.pathfinder.goto(new GoalBlock(targetPos.x, targetPos.y, targetPos.z));
  } catch {
    // Pathfinder failed — nudge forward with control states
    bot.clearControlStates();
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 500));
    bot.clearControlStates();
  }
}

// ── Main tunnel function ──────────────────────────────────────────────────────

async function startTunnel(bot, length = DEFAULT_LENGTH) {
  if (state.behaviorMode === 'tunneling') {
    bot.chat('Already tunneling. Say stop to cancel.');
    return;
  }

  const masterEntity = bot.players[MASTER]?.entity;
  if (!masterEntity) { bot.chat("Can't see where you're looking."); return; }

  const dir  = yawToCardinal(-masterEntity.yaw);
  const name = dirName(dir);

  const pickaxe = getBestPickaxe(bot);
  if (!pickaxe) { bot.chat("I don't have a pickaxe."); return; }

  bot.chat(`Tunneling ${name} — ${length} blocks. Say stop to cancel.`);
  setBehavior(bot, 'tunneling', MASTER);
  bot.pathfinder.setGoal(null);

  let torchCounter = 0;

  for (let i = 0; i < length; i++) {
    if (state.behaviorMode !== 'tunneling') break;

    // Health abort
    if (bot.health <= 4) {
      bot.chat('Health critical — stopping tunnel!');
      break;
    }

    const feet   = bot.entity.position.floored();
    const feetTarget = feet.plus(dir);       // 1 block ahead, feet level
    const headTarget = feetTarget.offset(0, 1, 0); // same column, head level
    const ceilTarget = feetTarget.offset(0, 2, 0); // ceiling — check for falling blocks

    // ── Ceiling check: clear falling blocks above head before digging ─────
    const ceilBlock = bot.blockAt(ceilTarget);
    if (ceilBlock && FALLING_BLOCKS.has(ceilBlock.name)) {
      await safeDig(bot, ceilTarget, pickaxe);
    }

    // ── Dig feet-level block ───────────────────────────────────────────────
    await safeDig(bot, feetTarget, pickaxe);
    if (state.behaviorMode !== 'tunneling') break;

    // ── Dig head-level block ───────────────────────────────────────────────
    await safeDig(bot, headTarget, pickaxe);
    if (state.behaviorMode !== 'tunneling') break;

    // ── Clear any falling blocks that landed after digging ─────────────────
    const postDig = bot.blockAt(feetTarget);
    if (postDig && FALLING_BLOCKS.has(postDig.name)) {
      await safeDig(bot, feetTarget, pickaxe);
    }

    // ── Step forward ───────────────────────────────────────────────────────
    if (state.behaviorMode !== 'tunneling') break;
    await stepForward(bot, feetTarget);

    // ── Torch placement ────────────────────────────────────────────────────
    torchCounter++;
    if (torchCounter >= TORCH_INTERVAL) {
      torchCounter = 0;
      await placeTorch(bot, bot.entity.position.floored(), dir);
    }
  }

  if (state.behaviorMode === 'tunneling') {
    clearBehavior(bot);
    bot.chat(`Tunnel complete — ${dirName(dir)}.`);
  }
}

module.exports = { startTunnel };
