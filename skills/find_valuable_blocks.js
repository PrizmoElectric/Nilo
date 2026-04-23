// Skill: find_valuable_blocks
// Description: scan nearby chunks for diamond ore, iron ore, gold ore and report locations
// Handcrafted: true

async function niloSkill(bot) {
  const targets = ['diamond_ore', 'iron_ore', 'gold_ore', 'ancient_debris', 'emerald_ore']
    .map(n => bot.registry.blocksByName[n]?.id)
    .filter(Boolean);

  if (!targets.length) throw new Error('No ore block IDs found in registry');

  const blocks = bot.findBlocks({ matching: targets, maxDistance: 64, count: 20 });
  if (!blocks.length) {
    bot.chat('No valuable ores found within 64 blocks.');
    return 'no ores found';
  }

  const grouped = {};
  for (const pos of blocks) {
    const block = bot.blockAt(pos);
    grouped[block.name] = (grouped[block.name] || 0) + 1;
  }

  const summary = Object.entries(grouped).map(([n, c]) => `${c}x ${n}`).join(', ');
  bot.chat(`Found: ${summary}`);
  return `found ores: ${summary}`;
}

module.exports = niloSkill;
