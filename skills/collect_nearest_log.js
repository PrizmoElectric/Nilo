// Skill: collect_nearest_log
// Description: pathfind to and collect the nearest wood log block
// Handcrafted: true

async function niloSkill(bot) {
  const logIds = Object.keys(bot.registry.blocksByName)
    .filter(n => n.endsWith('_log') || n === 'log')
    .map(n => bot.registry.blocksByName[n].id);

  if (!logIds.length) throw new Error('No log block types in registry');

  const block = bot.findBlock({ matching: logIds, maxDistance: 32 });
  if (!block) throw new Error('No log found within 32 blocks');

  bot.chat(`Collecting ${block.name}...`);
  await bot.collectBlock.collect(block);
  return `collected ${block.name}`;
}

module.exports = niloSkill;
