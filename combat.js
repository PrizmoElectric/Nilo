// combat.js — hostile mob detection, weapon helpers, melee and bow combat

const Vec3 = require('vec3');
const { goals: { GoalNear } } = require('mineflayer-pathfinder');
const state  = require('./state');
const { setBehavior } = require('./behavior');
const { createMovements } = require('./movement');
const { MASTER } = require('./config');

// ── Hostile mob list ──────────────────────────────────────────────────────────

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','witch','enderman','slime',
  'blaze','ghast','wither_skeleton','phantom','drowned','husk','stray','pillager',
  'vindicator','ravager','evoker','vex','hoglin','zoglin','piglin_brute',
  'guardian','elder_guardian','shulker','silverfish','endermite','magma_cube',
  'zombie_villager','zombie_pigman','zombified_piglin','warden','breeze',
]);

function isHostileMob(entity) {
  return entity.type === 'mob' && (HOSTILE_MOBS.has(entity.name) || entity.type === 'hostile');
}

// ── Arrow physics constants ───────────────────────────────────────────────────

const ARROW_GRAVITY   = 0.05;   // blocks/tick² — applied every tick
const BOW_ARROW_SPEED = 3.0;    // blocks/tick at full draw
const BOLT_SPEED      = 3.15;   // crossbow bolt is slightly faster
const CHARGE_BOW_MS   = 900;    // full bow draw (~18 ticks)
const CHARGE_XBOW_MS  = 1250;   // crossbow load time (~25 ticks)

// ── Weapon / shield helpers ───────────────────────────────────────────────────

function equipBestMeleeWeapon(bot) {
  const priority = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe',
  ];
  for (const name of priority) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) { bot.equip(item, 'hand').catch(() => {}); return; }
  }
}

// equipBestRanged — returns { item, isCrossbow, speed } or null if no ammo.
// Prefers crossbow over bow.
function equipBestRanged(bot) {
  const inv    = bot.inventory.items();
  const xbow   = inv.find(i => i.name === 'crossbow');
  const bow    = inv.find(i => i.name === 'bow');
  const arrows = inv.find(i => i.name.includes('arrow'));
  if (!arrows) return null;
  if (xbow) return { item: xbow, isCrossbow: true,  speed: BOLT_SPEED      };
  if (bow)  return { item: bow,  isCrossbow: false, speed: BOW_ARROW_SPEED };
  return null;
}

// Keep old name for backwards compat with existing callers
function hasBowAndArrows(bot) {
  const r = equipBestRanged(bot);
  return r ? { bow: r.item, arrows: true } : null;
}

function equipShield(bot) {
  const shield = bot.inventory.items().find(i => i.name === 'shield');
  if (shield) bot.equip(shield, 'off-hand').catch(() => {});
}

// ── Smart melee attack ────────────────────────────────────────────────────────

function startAttack(bot, username) {
  setBehavior(bot, 'attack', username);
  bot.chat('On it.');
  equipShield(bot);
  equipBestMeleeWeapon(bot);
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let lastSwing = 0;
  let shieldUp  = false;

  const lowerShield = () => { if (shieldUp) { bot.deactivateItem(); shieldUp = false; } };
  const raiseShield = () => { if (!shieldUp) { bot.activateItem(true); shieldUp = true; } }; // true = off-hand

  state.behaviorInterval = setInterval(async () => {
    if (state.behaviorMode !== 'attack') { lowerShield(); return; }

    // Retreat when critically low on health
    if (bot.health <= 4) {
      lowerShield();
      bot.pathfinder.setGoal(null);
      bot.chat('I need to retreat!');
      setBehavior(bot, 'idle', username);
      return;
    }

    const mob = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) < 24);
    if (!mob) { bot.pathfinder.setGoal(null); lowerShield(); return; }

    const dist = mob.position.distanceTo(bot.entity.position);
    try {
      if (dist > 3) {
        lowerShield(); // lower while sprinting — shield slows movement
        bot.pathfinder.setGoal(new GoalNear(mob.position.x, mob.position.y, mob.position.z, 2), true);
      } else {
        bot.pathfinder.setGoal(null);
        raiseShield(); // raise as soon as mob is in melee range
        await bot.lookAt(mob.position.offset(0, mob.height * 0.9, 0), true);
        const now = Date.now();
        if (now - lastSwing >= 500) {
          bot.attack(mob);
          lastSwing = now;
        }
      }
    } catch (err) {
      console.error('[NILO] Attack error:', err.message);
    }
  }, 200);
}

// ── Ballistic aim solver ──────────────────────────────────────────────────────

// solveAimPoint — iteratively find the world point to look at so the arrow
// intercepts a moving target, accounting for gravity and drag.
//
//   eyePos   — Vec3: shooter's eye position
//   targetPos — Vec3: target's aim centre (feet + height offset)
//   targetVel — Vec3: target's velocity in blocks/tick
//   arrowSpeed — blocks/tick at full charge
//
// Returns a Vec3 aim point (world coords, elevated for gravity compensation).
function solveAimPoint(eyePos, targetPos, targetVel, arrowSpeed) {
  // Initial flight-time estimate: straight-line distance / speed
  let t = eyePos.distanceTo(targetPos) / arrowSpeed;

  for (let i = 0; i < 8; i++) {
    // Predict where target will be after t ticks
    const pred = targetPos.offset(
      targetVel.x * t,
      targetVel.y * t,
      targetVel.z * t
    );

    // Gravity compensation: arrow falls ~½ g t² over the flight
    const gravityDrop = 0.5 * ARROW_GRAVITY * t * t;
    const aimPoint    = pred.offset(0, gravityDrop, 0);

    // Effective arrow speed decays each tick due to drag (0.99/tick).
    // Approximate: effective_speed = speed * (1 - 0.99^t) / (t * 0.01)
    const dragFactor    = t > 0 ? (1 - Math.pow(0.99, t)) / (t * 0.01) : 1;
    const effectiveSpeed = arrowSpeed * Math.max(dragFactor, 0.5);

    t = eyePos.distanceTo(aimPoint) / effectiveSpeed;
  }

  // Final prediction
  const pred = targetPos.offset(targetVel.x * t, targetVel.y * t, targetVel.z * t);
  return pred.offset(0, 0.5 * ARROW_GRAVITY * t * t, 0);
}

// ── Single precision shot ─────────────────────────────────────────────────────

// shootAtEntity — equip bow/crossbow, draw, re-aim every 50 ms while charging,
// then release. Returns true on success.
async function shootAtEntity(bot, entity) {
  const ranged = equipBestRanged(bot);
  if (!ranged) { bot.chat('No bow or arrows.'); return false; }

  try { await bot.equip(ranged.item, 'hand'); }
  catch { bot.chat("Couldn't equip ranged weapon."); return false; }

  const chargeMs = ranged.isCrossbow ? CHARGE_XBOW_MS : CHARGE_BOW_MS;

  const getAimPoint = () => {
    const eye    = bot.entity.position.offset(0, bot.entity.height, 0);
    const centre = entity.position.offset(0, (entity.height ?? 1.8) * 0.8, 0);
    return solveAimPoint(eye, centre, entity.velocity ?? new Vec3(0, 0, 0), ranged.speed);
  };

  await bot.lookAt(getAimPoint(), true);
  bot.activateItem(); // start draw / load

  // Re-aim while charging
  let released = false;
  const aimInterval = setInterval(() => {
    if (released) return;
    bot.lookAt(getAimPoint(), false).catch(() => {});
  }, 50);

  await new Promise(r => setTimeout(r, chargeMs));
  released = true;
  clearInterval(aimInterval);

  await bot.lookAt(getAimPoint(), true); // final precise aim
  bot.deactivateItem();                  // release arrow / fire bolt
  return true;
}

// shootAtPosition — single shot at a static world position (block face, coords).
async function shootAtPosition(bot, targetPos) {
  const ranged = equipBestRanged(bot);
  if (!ranged) { bot.chat('No bow or arrows.'); return false; }

  try { await bot.equip(ranged.item, 'hand'); }
  catch { bot.chat("Couldn't equip ranged weapon."); return false; }

  const eye         = bot.entity.position.offset(0, bot.entity.height, 0);
  const t           = eye.distanceTo(targetPos) / ranged.speed;
  const gravityDrop = 0.5 * ARROW_GRAVITY * t * t;
  await bot.lookAt(targetPos.offset(0, gravityDrop, 0), true);

  const chargeMs = ranged.isCrossbow ? CHARGE_XBOW_MS : CHARGE_BOW_MS;
  bot.activateItem();
  await new Promise(r => setTimeout(r, chargeMs));
  bot.deactivateItem();
  return true;
}

// shootAtGazeTarget — fire at whatever MASTER is currently looking at.
// Entity → shootAtEntity. Block/position → shootAtPosition.
async function shootAtGazeTarget(bot) {
  const { getPlayerGazeTarget } = require('./gaze');
  const hit = getPlayerGazeTarget(bot, 64);

  if (hit.entity) {
    bot.chat('*takes aim*');
    return shootAtEntity(bot, hit.entity);
  }
  if (hit.position) {
    bot.chat('*fires*');
    return shootAtPosition(bot, hit.position);
  }
  bot.chat('Nothing in range to shoot at.');
  return false;
}

// ── Bow combat mode ───────────────────────────────────────────────────────────

function startBowMode(bot) {
  const BOW_RANGE    = 26;
  const OPTIMAL_DIST = 14; // preferred engagement distance
  const KITE_DIST    = 6;  // back away if mob closer than this

  setBehavior(bot, 'bow', MASTER);
  bot.chat('Bow ready.');

  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let shooting = false;

  state.behaviorInterval = setInterval(async () => {
    if (state.behaviorMode !== 'bow') return;
    if (shooting) return;

    const hostile = Object.values(bot.entities).find(e =>
      isHostileMob(e) && e.position.distanceTo(bot.entity.position) < BOW_RANGE
    );

    if (!hostile) { bot.pathfinder.setGoal(null); return; }

    if (!equipBestRanged(bot)) {
      bot.chat('Out of arrows — going melee.');
      startAttack(bot, MASTER);
      return;
    }

    const dist = hostile.position.distanceTo(bot.entity.position);

    // Kite: too close — back off to optimal range
    if (dist < KITE_DIST) {
      const p = bot.entity.position, m = hostile.position;
      const dx = p.x - m.x, dz = p.z - m.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      bot.pathfinder.setGoal(
        new GoalNear(p.x + (dx / len) * OPTIMAL_DIST, p.y, p.z + (dz / len) * OPTIMAL_DIST, 2), true
      );
      return;
    }

    // Too far — close in
    if (dist > BOW_RANGE * 0.85) {
      bot.pathfinder.setGoal(
        new GoalNear(hostile.position.x, hostile.position.y, hostile.position.z, OPTIMAL_DIST), true
      );
      return;
    }

    // In range — stop and shoot
    shooting = true;
    bot.pathfinder.setGoal(null);
    try {
      await shootAtEntity(bot, hostile);
      if (state.behaviorMode !== 'bow') { shooting = false; return; }
      await new Promise(r => setTimeout(r, 400)); // brief cooldown between shots
    } catch (err) {
      console.error('[NILO] Bow error:', err.message);
    }
    shooting = false;
  }, 300);
}

module.exports = {
  HOSTILE_MOBS, isHostileMob,
  equipBestMeleeWeapon, equipBestRanged, hasBowAndArrows, equipShield,
  solveAimPoint, shootAtEntity, shootAtPosition, shootAtGazeTarget,
  startAttack, startBowMode,
};
