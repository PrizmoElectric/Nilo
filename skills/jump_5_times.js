// Skill: jump_5_times
// Description: jump 5 times in a row
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  for (let i = 0; i < 5; i++) {
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 250));
    bot.setControlState('jump', false);
    await new Promise(r => setTimeout(r, 400));
  }
  return 'jumped 5 times';
}

module.exports = niloSkill;
