// Skill: wave
// Description: wave by swinging arm repeatedly
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.chat('*waves*');
  for (let i = 0; i < 6; i++) {
    bot.swingArm();
    await new Promise(r => setTimeout(r, 280));
  }
  return 'waved';
}

module.exports = niloSkill;
