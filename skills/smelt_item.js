// Skill: smelt_item
// Description: open nearest furnace, report its current input/fuel/output slots
// Handcrafted: true

async function niloSkill(bot) {
  const furnaceBlock = bot.findBlock({
    matching: ['furnace', 'lit_furnace']
      .filter(n => bot.registry.blocksByName[n])
      .map(n => bot.registry.blocksByName[n].id),
    maxDistance: 6,
  });
  if (!furnaceBlock) throw new Error('No furnace within 6 blocks');

  const furnace = await bot.openFurnace(furnaceBlock);
  const input  = furnace.inputItem()  ? `${furnace.inputItem().count}x ${furnace.inputItem().name}`  : 'empty';
  const fuel   = furnace.fuelItem()   ? `${furnace.fuelItem().count}x ${furnace.fuelItem().name}`    : 'empty';
  const output = furnace.outputItem() ? `${furnace.outputItem().count}x ${furnace.outputItem().name}` : 'empty';
  furnace.close();

  bot.chat(`Furnace — input: ${input}, fuel: ${fuel}, output: ${output}`);
  return `furnace checked: input=${input} fuel=${fuel} output=${output}`;
}

module.exports = niloSkill;
