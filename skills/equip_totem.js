// Skill: equip_totem
// Description: equip a totem of undying to the offhand if one is in inventory
// Handcrafted: true

async function niloSkill(bot) {
  const totemId = bot.registry.itemsByName.totem_of_undying?.id;
  if (!totemId) throw new Error('Totem of undying not in registry');
  const totem = bot.inventory.findInventoryItem(totemId, null);
  if (!totem) throw new Error('No totem of undying in inventory');
  await bot.equip(totem, 'off-hand');
  return 'totem of undying equipped to offhand';
}

module.exports = niloSkill;
