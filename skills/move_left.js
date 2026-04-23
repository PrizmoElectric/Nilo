// Skill: move_left
// Description: strafe left for 2 seconds
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.setControlState('left', true);
  await new Promise(r => setTimeout(r, 2000));
  bot.clearControlStates();
  return 'moved left';
}

module.exports = niloSkill;
