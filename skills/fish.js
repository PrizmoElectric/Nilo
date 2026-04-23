// Skill: fish
// Description: equip fishing rod and cast a line, recast automatically on catch
// Handcrafted: true

async function niloSkill(bot) {
  const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
  if (!rod) throw new Error('No fishing rod in inventory');
  await bot.equip(rod, 'hand');
  bot.chat('Fishing...');

  return await new Promise((resolve, reject) => {
    let caught = 0;

    function onCollect(player, entity) {
      if (entity.kind === 'Drops' && player === bot.entity) {
        caught++;
        bot.removeListener('playerCollect', onCollect);
        resolve(`caught ${caught} item(s) while fishing`);
      }
    }

    bot.on('playerCollect', onCollect);

    bot.fish().catch(err => {
      bot.removeListener('playerCollect', onCollect);
      reject(new Error(`Fishing failed: ${err.message}`));
    });

    // Stop after 60 seconds regardless
    setTimeout(() => {
      bot.removeListener('playerCollect', onCollect);
      bot.activateItem(); // retract line
      resolve('stopped fishing after timeout');
    }, 60000);
  });
}

module.exports = niloSkill;
