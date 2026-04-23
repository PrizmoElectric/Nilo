// Skill: sleep_in_bed
// Description: find the nearest bed and sleep in it
// Handcrafted: true

async function niloSkill(bot) {
  const bed = bot.findBlock({ matching: block => bot.isABed(block) });
  if (!bed) throw new Error('No bed found nearby');
  try {
    await bot.sleep(bed);
    return 'sleeping in bed';
  } catch (err) {
    throw new Error(`Can't sleep: ${err.message}`);
  }
}

module.exports = niloSkill;
