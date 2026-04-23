// Skill: crouch_stand
// Description: crouch for 2 seconds then stand up
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.chat('*crouches*');
  bot.setControlState('sneak', true);
  await new Promise(r => setTimeout(r, 2000));
  bot.setControlState('sneak', false);
  bot.chat('*stands up*');
  return 'crouched and stood up';
}

module.exports = niloSkill;
