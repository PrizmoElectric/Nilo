// Skill: sprint_forward
// Description: sprint forward for 3 seconds
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  await new Promise(r => setTimeout(r, 3000));
  bot.clearControlStates();
  return 'sprinted forward 3 seconds';
}

module.exports = niloSkill;
