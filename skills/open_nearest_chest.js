// Skill: open_nearest_chest
// Description: open the nearest chest and report its contents
// Handcrafted: true

async function niloSkill(bot) {
  const chestBlock = bot.findBlock({
    matching: ['chest', 'ender_chest', 'trapped_chest'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean),
    maxDistance: 6,
  });
  if (!chestBlock) throw new Error('No chest found within 6 blocks');
  const chest = await bot.openContainer(chestBlock);
  const items = chest.containerItems();
  const summary = items.length
    ? items.map(i => `${i.count}x ${i.name}`).join(', ')
    : 'empty';
  chest.close();
  bot.chat(`Chest contains: ${summary.slice(0, 200)}`);
  return `opened chest: ${summary.slice(0, 80)}`;
}

module.exports = niloSkill;
