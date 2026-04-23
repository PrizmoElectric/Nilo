// Skill: spin
// Description: do a full 360-degree spin in place
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  bot.chat('*spins*');
  const steps = 20;
  for (let s = 0; s < steps; s++) {
    await bot.look(bot.entity.yaw + (Math.PI * 2 / steps), bot.entity.pitch, false);
    await new Promise(r => setTimeout(r, 60));
  }
  return 'spun 360 degrees';
}

module.exports = niloSkill;
