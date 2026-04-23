// Skill: jump
// Description: jump once
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.setControlState('jump', true);
  await new Promise(r => setTimeout(r, 250));
  bot.setControlState('jump', false);
  return 'jumped';
}

module.exports = niloSkill;
