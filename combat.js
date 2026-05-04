// combat.js — hostile mob detection, weapon helpers, melee and bow combat

const Vec3 = require('vec3');
const { goals: { GoalNear } } = require('mineflayer-pathfinder');
const state  = require('./state');
const { setBehavior } = require('./behavior');
const { createMovements } = require('./movement');
const { MASTER } = require('./config');
const db     = require('./db');

// ── Hostile mob list ──────────────────────────────────────────────────────────

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','witch','enderman','slime',
  'blaze','ghast','wither_skeleton','phantom','drowned','husk','stray','pillager',
  'vindicator','ravager','evoker','vex','hoglin','zoglin','piglin_brute',
  'guardian','elder_guardian','shulker','silverfish','endermite','magma_cube',
  'zombie_villager','zombie_pigman','zombified_piglin','warden','breeze',
]);

const stmtGetEntity = db.prepare('SELECT is_hostile FROM entities WHERE name = ?');

function isHostileMob(entity) {
  if (!entity || entity.type === 'player' || entity.type === 'object') return false;
  const name = (entity.name || '').toLowerCase().replace(/^[a-z_]+:/, '');
  // DB knowledge (player-taught) takes priority over hardcoded list
  const row = stmtGetEntity.get(name);
  if (row !== undefined) return !!row.is_hostile;
  return HOSTILE_MOBS.has(name) || entity.type === 'hostile' || entity.kind === 'Hostile mobs';
}

// ── Arrow physics constants ───────────────────────────────────────────────────

const ARROW_GRAVITY   = 0.05;   // blocks/tick² — applied every tick
const BOW_ARROW_SPEED = 3.0;    // blocks/tick at full draw
const BOLT_SPEED      = 3.15;   // crossbow bolt is slightly faster
const CHARGE_BOW_MS   = 900;    // full bow draw (~18 ticks)
const CHARGE_XBOW_MS  = 1250;   // crossbow load time (~25 ticks)

// ── Weapon / shield helpers ───────────────────────────────────────────────────

function equipBestMeleeWeapon(bot) {
  const { isWeapon } = require('./items');
  const inv = bot.inventory.items();

  // 1. Custom modded weapon set by player command
  if (state.customWeapon) {
    const custom = inv.find(i => i.name === state.customWeapon);
    if (custom) { bot.equip(custom, 'hand').catch(() => {}); return; }
  }

  // 2. Vanilla priority list
  const priority = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe',
  ];
  for (const name of priority) {
    const item = inv.find(i => i.name === name);
    if (item) { bot.equip(item, 'hand').catch(() => {}); return; }
  }

  // 3. Any modded weapon (isWeapon keyword match)
  const modded = inv.find(i => isWeapon(i));
  if (modded) { bot.equip(modded, 'hand').catch(() => {}); }
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


function equipShield(bot) {
  const shield = bot.inventory.items().find(i => i.name === 'shield');
  if (shield) bot.equip(shield, 'off-hand').catch(() => {});
}

// ── Combat AI — shared autonomous combat tick ─────────────────────────────────
//
// Selects and executes the best action for one tick based on distance, health,
// and available weapons/skills. Called by startAttack, startAssist, and guard.
//
//   bot       — the mineflayer bot
//   anchorPos — Vec3 to search for targets around (null = bot's own position)
//
// Returns true if a target was found and action taken, false if no target.

const MELEE_RANGE  = 3;
const RANGED_RANGE = 32;
const KITE_DIST    = 5;    // back off when mob is this close in ranged mode
const RETREAT_HP   = 4;
const TOTEM_HP     = 6;

const _cd = {};  // action cooldown timestamps
function _hasCd(name, ms) { return Date.now() - (_cd[name] || 0) < ms; }
function _setCd(name)     { _cd[name] = Date.now(); }

async function combatTick(bot, anchorPos) {
  // ── Passive: equip totem if health low ──────────────────────────────────
  if (bot.health <= TOTEM_HP && !_hasCd('totem', 15000)) {
    const totemId = bot.registry.itemsByName.totem_of_undying?.id;
    if (totemId && bot.inventory.findInventoryItem(totemId, null)) {
      _setCd('totem');
      const se = require('./skill-engine');
      if (se.hasSkill('equip_totem')) se.runSkill(bot, 'equip_totem').catch(() => {});
    }
  }

  const anchor = anchorPos || bot.entity.position;
  const target = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(anchor) < 24);
  if (!target) return false;

  const dist = target.position.distanceTo(bot.entity.position);

  // ── Retreat ──────────────────────────────────────────────────────────────
  if (bot.health <= RETREAT_HP) {
    if (!_hasCd('retreat', 800)) {
      _setCd('retreat');
      const p = bot.entity.position, m = target.position;
      const dx = p.x - m.x, dz = p.z - m.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      bot.pathfinder.setGoal(new GoalNear(p.x + (dx / len) * 10, p.y, p.z + (dz / len) * 10, 2), true);
    }
    return true;
  }

  // ── Melee ────────────────────────────────────────────────────────────────
  if (dist <= MELEE_RANGE) {
    bot.pathfinder.setGoal(null);
    if (!_hasCd('melee', 500)) {
      _setCd('melee');
      equipBestMeleeWeapon(bot);
      try {
        await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.9, 0), true);
        bot.attack(target);
      } catch (err) { console.error('[COMBAT] Melee error:', err.message); }
    }
    return true;
  }

  // ── Ranged (prefers perfect_shot_bow skill if registered) ────────────────
  const ranged = equipBestRanged(bot);
  if (ranged && dist <= RANGED_RANGE && !_hasCd('ranged', 2500)) {
    if (dist < KITE_DIST) {
      // Too close — back off to optimal range before shooting
      const p = bot.entity.position, m = target.position;
      const dx = p.x - m.x, dz = p.z - m.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      bot.pathfinder.setGoal(new GoalNear(p.x + (dx / len) * 14, p.y, p.z + (dz / len) * 14, 2), true);
      return true;
    }
    _setCd('ranged');
    bot.pathfinder.setGoal(null);
    const se = require('./skill-engine');
    if (se.hasSkill('perfect_shot_bow')) {
      se.runSkill(bot, 'perfect_shot_bow').catch(() => {});
    } else {
      try { await bot.equip(ranged.item, 'hand'); } catch (_) {}
      shootAtEntity(bot, target).catch(() => {});
    }
    return true;
  }

  // ── Close in for melee ───────────────────────────────────────────────────
  if (!_hasCd('close_in', 300)) {
    _setCd('close_in');
    equipBestMeleeWeapon(bot);
    bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
  }
  return true;
}

// ── Smart melee attack ────────────────────────────────────────────────────────

function startAttack(bot, username) {
  setBehavior(bot, 'attack', username);
  bot.chat('On it.');
  equipShield(bot);
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let shieldUp = false;
  const lower = () => { if (shieldUp) { bot.deactivateItem(); shieldUp = false; } };
  const raise = () => { if (!shieldUp) { bot.activateItem(true); shieldUp = true; } };

  state.behaviorInterval = setInterval(async () => {
    if (state.behaviorMode !== 'attack') { lower(); return; }
    if (bot.health <= RETREAT_HP) {
      lower(); bot.pathfinder.setGoal(null);
      bot.chat('I need to retreat!');
      setBehavior(bot, 'idle', username);
      return;
    }
    const engaged = await combatTick(bot, null);
    if (!engaged) { lower(); bot.pathfinder.setGoal(null); return; }
    // Shield up only when in melee range
    const inMelee = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) <= MELEE_RANGE);
    if (inMelee) raise(); else lower();
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

// ── Assist mode — follow player and attack nearby hostiles ───────────────────

function startAssist(bot, username) {
  setBehavior(bot, 'assist', username);
  equipShield(bot);
  bot.chat('Covering you.');
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let shieldUp = false;
  const lower = () => { if (shieldUp) { bot.deactivateItem(); shieldUp = false; } };
  const raise = () => { if (!shieldUp) { bot.activateItem(true); shieldUp = true; } };

  state.behaviorInterval = setInterval(async () => {
    if (state.behaviorMode !== 'assist') { lower(); return; }
    if (bot.health <= RETREAT_HP) {
      lower(); bot.pathfinder.setGoal(null);
      bot.chat('I need to retreat!');
      setBehavior(bot, 'idle', username);
      return;
    }

    const player = bot.players[username]?.entity;
    if (!player) { bot.pathfinder.setGoal(null); return; }

    // Search for targets around the PLAYER, not just the bot
    const engaged = await combatTick(bot, player.position);
    if (engaged) {
      const inMelee = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) <= MELEE_RANGE);
      if (inMelee) raise(); else lower();
    } else {
      // No mob — follow player
      lower();
      const dist = bot.entity.position.distanceTo(player.position);
      if (dist > 4) {
        bot.pathfinder.setGoal(new GoalNear(player.position.x, player.position.y, player.position.z, 3), true);
      } else {
        bot.pathfinder.setGoal(null);
      }
    }
  }, 200);
}

// ── Bow combat mode ───────────────────────────────────────────────────────────

function startBowMode(bot) {
  const BOW_RANGE    = 48;
  const OPTIMAL_DIST = 16;
  const KITE_DIST    = 6;

  setBehavior(bot, 'bow', MASTER);

  const ranged = equipBestRanged(bot);
  if (!ranged) { bot.chat("I don't have a bow or arrows."); return; }
  bot.chat('Archer mode. Keeping distance.');

  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let shooting = false;
  let lastShot  = 0;
  const SHOT_CD = 2200; // ms — minimum gap between shots regardless of skill speed

  state.behaviorInterval = setInterval(async () => {
    if (state.behaviorMode !== 'bow') return;
    if (shooting) return;
    if (Date.now() - lastShot < SHOT_CD) return;

    const hostile = bot.nearestEntity(e =>
      isHostileMob(e) && e.position.distanceTo(bot.entity.position) < BOW_RANGE
    );

    if (!hostile) { bot.pathfinder.setGoal(null); return; }

    if (!equipBestRanged(bot)) {
      bot.chat('Out of arrows — switching to melee.');
      startAttack(bot, MASTER);
      return;
    }

    const dist = hostile.position.distanceTo(bot.entity.position);

    // Kite: too close — back off
    if (dist < KITE_DIST) {
      const p = bot.entity.position, m = hostile.position;
      const dx = p.x - m.x, dz = p.z - m.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      bot.pathfinder.setGoal(
        new GoalNear(p.x + (dx / len) * OPTIMAL_DIST, p.y, p.z + (dz / len) * OPTIMAL_DIST, 2), true
      );
      return;
    }

    // Too far — close in to optimal range
    if (dist > BOW_RANGE * 0.85) {
      bot.pathfinder.setGoal(
        new GoalNear(hostile.position.x, hostile.position.y, hostile.position.z, OPTIMAL_DIST), true
      );
      return;
    }

    // In range — shoot
    shooting = true;
    lastShot  = Date.now();
    bot.pathfinder.setGoal(null);
    try {
      const se = require('./skill-engine');
      if (se.hasSkill('perfect_shot_bow')) {
        await se.runSkill(bot, 'perfect_shot_bow');
      } else {
        await shootAtEntity(bot, hostile);
      }
      if (state.behaviorMode !== 'bow') { shooting = false; return; }
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error('[NILO] Bow error:', err.message);
    }
    shooting = false;
  }, 300);
}

module.exports = {
  isHostileMob,
  equipBestMeleeWeapon, equipBestRanged, equipShield,
  combatTick,
  solveAimPoint, shootAtEntity, shootAtPosition, shootAtGazeTarget,
  startAttack, startAssist, startBowMode,
  MELEE_RANGE, RETREAT_HP,
};
