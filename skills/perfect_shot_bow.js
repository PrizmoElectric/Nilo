// Skill: perfect_shot_bow
// Description: fire a single precisely-aimed shot at the nearest hostile mob using minecrafthawkeye ballistics
// Handcrafted: true

const { isHostileMob } = require('../combat');

async function niloSkill(bot) {
  if (!bot.hawkEye) throw new Error('minecrafthawkeye plugin not loaded');

  const arrows = bot.inventory.items().find(i => i.name.includes('arrow'));
  if (!arrows) throw new Error('No arrows in inventory');

  const weapon = bot.inventory.items().find(i => i.name === 'bow') ||
                 bot.inventory.items().find(i => i.name === 'crossbow');
  if (!weapon) throw new Error('No bow or crossbow in inventory');

  await bot.equip(weapon, 'hand');

  // Only target hostile mobs — never players
  const mob = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) < 60);
  if (!mob) throw new Error('No hostile target in range');

  const target = {
    position: mob.position.offset(0, (mob.height ?? 1) * 0.6, 0),
    velocity: mob.velocity ?? { x: 0, y: 0, z: 0 },
    isValid: true,
  };

  // oneShot adds a physicsTick listener internally — wrap in a promise so we
  // wait for the shot to actually fire before returning (prevents rapid re-firing)
  await new Promise((resolve) => {
    bot.hawkEye.oneShot(target, weapon.name);
    // hawkeye fires on the next few physics ticks; wait for the full charge + release
    const chargeMs = weapon.name === 'crossbow' ? 1300 : 950;
    setTimeout(resolve, chargeMs + 200);
  });

  return `${weapon.name} shot fired at ${mob.name ?? 'mob'}`;
}

module.exports = niloSkill;
