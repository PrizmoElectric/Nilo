// Skill: dig_below
// Description: dig the block directly below the bot's feet
// Handcrafted: true

async function niloSkill(bot) {
  const target = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!target || target.name === 'air') throw new Error('Nothing to dig below me');
  if (!bot.canDigBlock(target)) throw new Error(`Cannot dig ${target.name}`);
  bot.chat(`Digging ${target.name}...`);
  await bot.dig(target);
  return `dug ${target.name}`;
}

module.exports = niloSkill;
