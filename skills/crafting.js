// crafting.js — crafting, smelting, and recipe helpers
//
// Covers:
//   craftItem(bot, itemName, count)     — find recipe, navigate to table if needed, craft
//   smeltItem(bot, inputName, count)    — navigate to furnace, smelt items
//   ensureTools(bot)                    — craft missing basic tools if materials available
//   Natural language: "craft a pickaxe", "smelt the iron ore", "make a chest"

const Vec3  = require('vec3');
const { goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');
const state = require('./state');
const { createMovements } = require('./movement');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Resolve a human-readable name to a minecraft item/block name.
// Handles aliases like "pickaxe" → "wooden_pickaxe" fallback chain.
function resolveItemName(bot, query) {
  const q = query.toLowerCase().replace(/\s+/g, '_');

  // Exact match first
  if (bot.registry.itemsByName[q]) return q;

  // Search for partial match in registry
  const names = Object.keys(bot.registry.itemsByName);
  const exact  = names.find(n => n === q);
  if (exact) return exact;

  // Partial match — prefer shorter names (more specific)
  const partials = names.filter(n => n.includes(q)).sort((a, b) => a.length - b.length);
  if (partials.length) return partials[0];

  return null;
}

// Find the nearest crafting table within maxDistance blocks.
function findCraftingTable(bot, maxDistance = 32) {
  return bot.findBlock({
    matching: b => b.name === 'crafting_table',
    maxDistance,
  });
}

// Find the nearest furnace within maxDistance blocks.
function findFurnace(bot, maxDistance = 32) {
  return bot.findBlock({
    matching: b => b.name === 'furnace' || b.name === 'blast_furnace' || b.name === 'smoker',
    maxDistance,
  });
}

// Navigate to within reach of a block.
async function approachBlock(bot, block) {
  const p = block.position;
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);

  const adjacent = [
    new Vec3(p.x + 1, p.y, p.z), new Vec3(p.x - 1, p.y, p.z),
    new Vec3(p.x, p.y, p.z + 1), new Vec3(p.x, p.y, p.z - 1),
  ];
  for (const adj of adjacent) {
    try {
      await bot.pathfinder.goto(new GoalBlock(adj.x, adj.y, adj.z));
      return true;
    } catch (_) {}
  }
  // fallback
  await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));
  return true;
}

// Count how many of an item the bot has.
function countItem(bot, itemName) {
  return bot.inventory.items()
    .filter(i => i.name === itemName)
    .reduce((sum, i) => sum + i.count, 0);
}

// ── Crafting ──────────────────────────────────────────────────────────────────

async function craftItem(bot, itemName, count = 1) {
  const name = resolveItemName(bot, itemName);
  if (!name) {
    bot.chat(`I don't know how to make "${itemName}".`);
    return false;
  }

  const item = bot.registry.itemsByName[name];
  if (!item) {
    bot.chat(`Unknown item: ${name}`);
    return false;
  }

  // Try without crafting table first (2x2 inventory grid)
  let recipes = bot.recipesFor(item.id, null, 1, null);
  let table   = null;

  if (!recipes.length) {
    // Need a crafting table
    table = findCraftingTable(bot);
    if (!table) {
      // Try to place one from inventory
      const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (ctItem) {
        bot.chat('Placing crafting table...');
        table = await placeCraftingTable(bot);
      }
      if (!table) {
        bot.chat("I need a crafting table for that and I don't have one.");
        return false;
      }
    }
    recipes = bot.recipesFor(item.id, null, 1, table);
  }

  if (!recipes.length) {
    bot.chat(`I don't have a recipe for ${name}.`);
    return false;
  }

  // Check if we have ingredients — use first viable recipe
  const recipe = recipes[0];

  if (table) {
    bot.chat(`Going to crafting table to make ${count}x ${name}...`);
    try { await approachBlock(bot, table); } catch (_) {}
  }

  try {
    await bot.craft(recipe, count, table);
    bot.chat(`Crafted ${count}x ${name}.`);
    return true;
  } catch (err) {
    bot.chat(`Couldn't craft ${name}: ${err.message}`);
    console.error('[CRAFT]', err.message);
    return false;
  }
}

// Place a crafting table on the ground near the bot.
async function placeCraftingTable(bot) {
  const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!ctItem) return null;

  const pos   = bot.entity.position.floored();
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below || below.name === 'air') return null;

  try {
    await bot.equip(ctItem, 'hand');
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    // Give world a tick to register
    await new Promise(r => setTimeout(r, 200));
    return findCraftingTable(bot, 4);
  } catch (err) {
    console.error('[CRAFT] Place crafting table error:', err.message);
    return null;
  }
}

// ── Smelting ──────────────────────────────────────────────────────────────────

async function smeltItem(bot, inputName, count = 1) {
  const name = resolveItemName(bot, inputName);
  if (!name) { bot.chat(`I don't know what "${inputName}" is.`); return false; }

  const inInventory = countItem(bot, name);
  if (!inInventory) {
    bot.chat(`I don't have any ${name} to smelt.`);
    return false;
  }

  const furnaceBlock = findFurnace(bot);
  if (!furnaceBlock) {
    bot.chat("I can't find a furnace nearby.");
    return false;
  }

  bot.chat(`Smelting ${Math.min(count, inInventory)}x ${name}...`);

  try {
    await approachBlock(bot, furnaceBlock);
    const furnace = await bot.openFurnace(furnaceBlock);

    // Put fuel in if furnace has none
    if (furnace.fuelSeconds() < 5) {
      const fuel = bot.inventory.items().find(i =>
        ['coal', 'charcoal', 'oak_log', 'coal_block', 'lava_bucket',
         'blaze_rod', 'dried_kelp_block'].some(f => i.name.includes(f))
      );
      if (fuel) {
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 8));
      } else {
        bot.chat("No fuel to run the furnace.");
        furnace.close();
        return false;
      }
    }

    const inputItem = bot.inventory.items().find(i => i.name === name);
    if (!inputItem) { furnace.close(); bot.chat(`No ${name} in inventory.`); return false; }

    await furnace.putInput(inputItem.type, null, Math.min(count, inputItem.count));

    // Wait for smelting — roughly 10s per item, poll for output
    const toSmelt = Math.min(count, inputItem.count);
    bot.chat(`Waiting for ${toSmelt}x ${name} to smelt...`);

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        furnace.close();
        resolve();
      }, toSmelt * 11000 + 3000); // 10s per item + buffer

      furnace.on('update', () => {
        if (furnace.outputItem()) {
          clearTimeout(timeout);
          furnace.takeOutput()
            .then(() => { furnace.close(); resolve(); })
            .catch(() => { furnace.close(); resolve(); });
        }
      });
    });

    bot.chat('Smelting done.');
    return true;
  } catch (err) {
    bot.chat(`Smelting failed: ${err.message}`);
    console.error('[SMELT]', err.message);
    return false;
  }
}

// ── ensureTools ───────────────────────────────────────────────────────────────
// Tries to craft basic tools if missing. Called autonomously or on demand.

const TOOL_PRIORITY = [
  { name: 'wooden_pickaxe',  needs: [['oak_planks',3],['stick',2]] },
  { name: 'stone_pickaxe',   needs: [['cobblestone',3],['stick',2]] },
  { name: 'iron_pickaxe',    needs: [['iron_ingot',3],['stick',2]] },
  { name: 'wooden_sword',    needs: [['oak_planks',2],['stick',1]] },
  { name: 'stone_sword',     needs: [['cobblestone',2],['stick',1]] },
];

async function ensureTools(bot) {
  const inv = bot.inventory.items().map(i => i.name);
  const hasPickaxe = inv.some(n => n.includes('pickaxe'));
  const hasSword   = inv.some(n => n.includes('sword'));

  if (hasPickaxe && hasSword) return;

  bot.chat("Checking if I can craft missing tools...");

  for (const tool of TOOL_PRIORITY) {
    const alreadyHas = inv.includes(tool.name) ||
      (tool.name.includes('pickaxe') && hasPickaxe) ||
      (tool.name.includes('sword')   && hasSword);
    if (alreadyHas) continue;

    const canCraft = tool.needs.every(([mat, qty]) => countItem(bot, mat) >= qty);
    if (canCraft) {
      await craftItem(bot, tool.name, 1);
      break;
    }
  }
}

// ── What can I craft? ─────────────────────────────────────────────────────────
// Returns a short string listing craftable item names given current inventory.

function listCraftable(bot) {
  const table = findCraftingTable(bot, 32);
  const items = Object.values(bot.registry.itemsByName);
  const craftable = [];

  for (const item of items) {
    const recipes = bot.recipesFor(item.id, null, 1, table ?? null);
    if (recipes.length) craftable.push(item.name);
  }

  if (!craftable.length) return 'Nothing craftable with current inventory.';
  return `Can craft: ${craftable.slice(0, 20).join(', ')}${craftable.length > 20 ? ` (+${craftable.length - 20} more)` : ''}`;
}

module.exports = { craftItem, smeltItem, ensureTools, listCraftable, resolveItemName };
