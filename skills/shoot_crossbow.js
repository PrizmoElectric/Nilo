// Skill: shoot_crossbow
// Description: equip crossbow, charge it, aim at nearest mob and fire
// Handcrafted: true

async function niloSkill(bot) {
  const crossbow = bot.inventory.items().find(i => i.name === 'crossbow');
  if (!crossbow) throw new Error('No crossbow in inventory');
  await bot.equip(crossbow, 'hand');

  const target = bot.nearestEntity(e => e.type === 'mob');
  if (!target) throw new Error('No mob nearby to shoot');

  const enchants = bot.heldItem?.nbt?.value?.Enchantments?.value?.value;
  const quickCharge = enchants?.find(e => e.id?.value === 'quick_charge');
  const chargeTime = 1250 - ((quickCharge?.lvl?.value || 0) * 250);

  bot.chat(`Charging crossbow at ${target.displayName || target.name}...`);
  bot.activateItem();
  await new Promise(r => setTimeout(r, chargeTime));
  bot.deactivateItem();

  await bot.lookAt(target.position.offset(0, target.height / 2, 0), true);
  await bot.waitForTicks(3);
  bot.activateItem();
  bot.deactivateItem();

  return `shot crossbow at ${target.displayName || target.name}`;
}

module.exports = niloSkill;
