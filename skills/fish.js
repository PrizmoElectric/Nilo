// Skill: fish
// Description: equip fishing rod and start continuous fishing session
// Handcrafted: true

const { startFishing } = require('../activities');

async function niloSkill(bot) {
  startFishing(bot);
  return 'started fishing session';
}

module.exports = niloSkill;
