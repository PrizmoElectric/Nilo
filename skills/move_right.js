// Skill: move_right
// Description: strafe right for 2 seconds
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.setControlState('right', true);
  await new Promise(r => setTimeout(r, 2000));
  bot.clearControlStates();
  return 'moved right';
}

module.exports = niloSkill;
