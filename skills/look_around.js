// Skill: look_around
// Description: slowly pan around to observe the surroundings (full 360)
// Handcrafted: true
const { Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

async function niloSkill(bot) {
  const steps = 36; // 10 degrees per step
  // Tilt slightly up then down while spinning for a cinematic look
  for (let s = 0; s < steps; s++) {
    const t     = s / steps;
    const pitch = Math.sin(t * Math.PI * 2) * 0.4; // gentle up/down bob
    await bot.look(bot.entity.yaw + (Math.PI * 2 / steps), pitch, false);
    await new Promise(r => setTimeout(r, 80));
  }
  // Return to level gaze
  await bot.look(bot.entity.yaw, 0, false);
  return 'looked around';
}

module.exports = niloSkill;
