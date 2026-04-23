// Skill: list_villager_trades
// Description: find nearest villager within 3 blocks and list its available trades
// Handcrafted: true

async function niloSkill(bot) {
  const villagerId = bot.registry.entitiesByName.villager?.id;
  if (!villagerId) throw new Error('Villager entity not found in registry');

  const villagerEntity = bot.nearestEntity(
    e => e.entityType === villagerId && bot.entity.position.distanceTo(e.position) < 3
  );
  if (!villagerEntity) throw new Error('No villager within 3 blocks');

  const villager = await bot.openVillager(villagerEntity);
  const trades = villager.trades;
  villager.close();

  if (!trades.length) {
    bot.chat('Villager has no trades.');
    return 'villager has no trades';
  }

  trades.slice(0, 5).forEach((t, i) => {
    const input = `${t.inputItem1.count}x ${t.inputItem1.displayName}`;
    const input2 = t.inputItem2 ? ` + ${t.inputItem2.count}x ${t.inputItem2.displayName}` : '';
    const output = `${t.outputItem.count}x ${t.outputItem.displayName}`;
    const uses = `(${t.nbTradeUses}/${t.maximumNbTradeUses})`;
    bot.chat(`${i + 1}: ${input}${input2} → ${output} ${uses}`);
  });

  return `listed ${trades.length} villager trade(s)`;
}

module.exports = niloSkill;
