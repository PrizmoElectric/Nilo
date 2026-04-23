// Skill: attack_nearest_entity
// Description: attack the nearest non-player entity (mob)
// Handcrafted: true

async function niloSkill(bot) {
  const entity = bot.nearestEntity(e => e.type === 'mob' || (e.type !== 'player' && e.type !== 'object'));
  if (!entity) throw new Error('No nearby entities to attack');
  const name = entity.displayName || entity.name || 'entity';
  bot.chat(`Attacking ${name}!`);
  bot.attack(entity);
  return `attacked ${name}`;
}

module.exports = niloSkill;
