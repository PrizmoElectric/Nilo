// Skill: wake_up
// Description: wake up from bed if currently sleeping
// Handcrafted: true

async function niloSkill(bot) {
  if (!bot.isSleeping) throw new Error('Not currently sleeping');
  await bot.wake();
  return 'woke up';
}

module.exports = niloSkill;
