// Skill: sleep_in_bed
// Description: navigate to nearest bed and sleep in it
// Handcrafted: true

const { sleepInBed } = require('../activities');

async function niloSkill(bot) {
  await sleepInBed(bot);
  return 'attempted to sleep in bed';
}

module.exports = niloSkill;
