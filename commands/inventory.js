const { goals: { GoalNear } } = require('mineflayer-pathfinder');
const state  = require('../state');
const { pickupNearestItem, isEquippable, getEquipDestination } = require('../items');
const { equipShield } = require('../combat');
const { createMovements } = require('../movement');
const { MASTER } = require('../config');
const { cmd } = require('./_util');
const { getModdedBlockName, findBlocksByName } = require('../registry-patch');
const { getPlayerGazeTarget } = require('../gaze');

const STORAGE_KEYWORDS = [
  'chest', 'barrel', 'crate', 'storage', 'bin', 'locker', 'safe',
  'cabinet', 'trunk', 'box', 'vault', 'strongbox', 'terminal', 'interface', 'grid', 'cable_bus',
];

function findNearbyContainers(bot, maxDistance = 32) {
  const positions = [];
  for (const kw of STORAGE_KEYWORDS) {
    for (const pos of findBlocksByName(bot, kw, maxDistance, 20)) {
      if (!positions.some(p => p.equals(pos))) positions.push(pos);
      if (positions.length >= 20) break;
    }
    if (positions.length >= 20) break;
  }
  return positions.map(pos => bot.blockAt(pos)).filter(Boolean);
}

function itemLabel(item) {
  if (!item) return 'nothing';
  if (item.customName) return item.customName;
  if (item.displayName && item.displayName !== 'Unknown' && item.displayName !== 'unknown') return item.displayName;
  if (item.name && item.name !== 'unknown') return item.name;
  return `item#${item.type}`;
}

const IS_INVENTORY = cmd([
  /\b(inventory|invent[aá]rio|what('s| is) in (your |my )?bag|what are you (carrying|holding)|o que (você |vc )?t[eê]m|mostra (o )?invent[aá]rio)\b/,
  /\b(show (me )?(your )?(inventory|items?|stuff)|list (your )?(items?|stuff))\b/,
  /\b(what do you have|what('s| is) on you|what did you pick up)\b/,
  /\b(o que (você |vc )?carrega|seus itens|mostra (seus |os )?itens)\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_INVENTORY(lower)) {
    const items = bot.inventory.items();
    if (!items.length) { bot.chat('My inventory is empty.'); return true; }

    const groups = { weapons: [], tools: [], armor: [], food: [], blocks: [], other: [] };
    for (const item of items) {
      const n     = item.name;
      const entry = `${item.count}x ${n}`;
      if (/sword|axe|bow|crossbow|trident|mace/.test(n))             groups.weapons.push(entry);
      else if (/pickaxe|shovel|hoe|shears|flint_and_steel/.test(n))  groups.tools.push(entry);
      else if (/helmet|chestplate|leggings|boots|shield/.test(n))    groups.armor.push(entry);
      else if (bot.registry.foodsByName[n])                           groups.food.push(entry);
      else if (item.stackSize > 1)                                    groups.blocks.push(entry);
      else                                                            groups.other.push(entry);
    }

    const lines = [];
    const total = items.reduce((s, i) => s + i.count, 0);
    lines.push(`Inventory (${items.length} stacks, ${total} items):`);
    if (groups.weapons.length) lines.push(`⚔ ${groups.weapons.join(', ')}`);
    if (groups.tools.length)   lines.push(`⛏ ${groups.tools.join(', ')}`);
    if (groups.armor.length)   lines.push(`🛡 ${groups.armor.join(', ')}`);
    if (groups.food.length)    lines.push(`🍖 ${groups.food.join(', ')}`);
    if (groups.blocks.length)  lines.push(`🧱 ${groups.blocks.join(', ')}`);
    if (groups.other.length)   lines.push(`📦 ${groups.other.join(', ')}`);

    for (const line of lines) {
      if (line.length <= 200) { bot.chat(line); continue; }
      const parts = line.match(/.{1,190}(?:,|$)/g) || [line];
      for (const part of parts) bot.chat(part.trim().replace(/^,\s*/, ''));
    }
    return true;
  }

  // Open what MASTER is looking at — "open it", "open this chest", "read chest"
  if (/\b(open (it|this|that)|read (the )?chest|check (the )?chest|open (the )?(chest|barrel|box|storage|container|ba[uú]|caixote))\b/.test(lower)) {
    const { block } = getPlayerGazeTarget(bot, 8);
    if (!block?.position) { bot.chat("I don't see anything to open."); return true; }
    const p = block.position;
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 3));
      await bot.lookAt(p.offset(0.5, 0.5, 0.5), true);
      const win = await bot.openContainer(bot.blockAt(p));
      const items = win.containerItems();
      if (!items.length) {
        bot.chat(`${block.name} is empty.`);
      } else {
        const summary = items.slice(0, 10).map(i => `${i.count}x ${i.name}`).join(', ');
        const more = items.length > 10 ? ` (+${items.length - 10} more)` : '';
        bot.chat(`${block.name}: ${summary}${more}`);
      }
      win.close();
    } catch (err) {
      console.error(`[NILO] Open gaze failed (${block.name}): ${err.message}`);
      bot.chat("Couldn't open that.");
    }
    return true;
  }

  // Equip this/that
  if (/\b(equip this|equip that|equipa isso|equipa ess[ae]|veste ess[ae]|equipa aqui)\b/.test(lower)) {
    await pickupNearestItem(bot, 8);
    const item = bot.inventory.items().find(isEquippable);
    if (!item) { bot.chat("Nothing equippable on me."); return true; }
    const dest = getEquipDestination(item);
    try {
      await bot.equip(item, dest);
      bot.chat(`Equipped ${itemLabel(item)}.`);
      if (dest === 'hand' && (state.behaviorMode === 'attack' || state.behaviorMode === 'defensive')) equipShield(bot);
    } catch (_) { bot.chat("Couldn't equip that."); }
    return true;
  }

  // Equip named item — "equip iron_sword", "equip my bow"
  {
    const SKIP = ['this', 'that', 'isso', 'esse', 'essa', 'aqui', 'it'];
    const m = lower.match(/\b(?:equip|hold|wield|equipar?|segura(?:r)?|p[õo]e na m[ãa]o|coloca na m[ãa]o)\b\s+(?:(?:my|the|your|a|an|o|a|um|uma)\s+)?["']?([a-z0-9_][a-z0-9_ ]*?)["']?\s*$/);
    if (m && !SKIP.includes(m[1].trim())) {
      const query = m[1].trim().replace(/\s+/g, '_');
      const inv   = bot.inventory.items();
      const item  = inv.find(i => i.name.includes(query))
                 ?? inv.find(i => query.split('_').every(w => i.name.includes(w)));
      if (!item) { bot.chat(`I don't have a ${query}.`); return true; }
      const dest = getEquipDestination(item);
      try {
        await bot.equip(item, dest);
        bot.chat(`Equipped ${itemLabel(item)}.`);
        if (dest === 'hand' && (state.behaviorMode === 'attack' || state.behaviorMode === 'defensive')) equipShield(bot);
      } catch (_) { bot.chat(`Couldn't equip ${itemLabel(item)}.`); }
      return true;
    }
  }

  // Use X as weapon
  {
    const m = raw.match(/\b(?:use|equip|hold|wield|usa|equipa|segura)\s+(.+?)\s+as\s+(?:a\s+)?(?:melee\s+)?weapon\b/i)
           ?? raw.match(/\b(?:use|equip|hold|wield|usa|equipa|segura)\s+(.+?)\s+(?:como\s+)?arma\b/i);
    if (m) {
      const query = m[1].trim().toLowerCase().replace(/\s+/g, '_');
      const inv   = bot.inventory.items();
      const item  = inv.find(i => i.name.includes(query))
                 ?? inv.find(i => query.split('_').every(w => i.name.includes(w)));
      if (!item) { bot.chat(`I don't have "${m[1].trim()}".`); return true; }
      state.customWeapon = item.name;
      try {
        await bot.equip(item, 'hand');
        bot.chat(`Using ${itemLabel(item)} as my weapon.`);
      } catch (_) { bot.chat(`Couldn't equip ${itemLabel(item)}.`); }
      return true;
    }
  }

  // Give me that
  if (/\b(give me that|hand (it|that) over|drop that|throw (it|that)|me (dá|da) isso|me (passa|joga) isso|me dá o que (tá|está) na sua m[ãa]o)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try {
      const player = bot.players[MASTER]?.entity;
      if (player) {
        await bot.pathfinder.goto(new GoalNear(player.position.x, player.position.y, player.position.z, 2));
      }
      await bot.tossStack(held);
      bot.chat('Here.');
    } catch (_) { bot.chat("Couldn't drop that."); }
    return true;
  }

  // Unequip and give
  if (/\b(unequip and give me|unequip.*give me|tira e me (da|dá)|tira.*me (da|dá))\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try {
      const target = bot.players[MASTER]?.entity;
      if (target) {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
      }
      await bot.unequip('hand');
      await bot.tossStack(held);
      bot.chat(`Here, ${itemLabel(held)}.`);
    } catch (_) { bot.chat("Couldn't hand that over."); }
    return true;
  }

  // Unequip
  if (/\b(unequip that|unequip this|tira isso|tira ess[ae]|desequipa isso)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try { await bot.unequip('hand'); bot.chat(`Unequipped ${itemLabel(held)}.`); }
    catch (_) { bot.chat("Couldn't unequip that."); }
    return true;
  }

  // Drop all
  if (/\b(drop all|drop everything|drop all (your |the )?items?|esvazia (seu |o )?invent[aá]rio|joga tudo fora|larga tudo)\b/.test(lower)) {
    const items = bot.inventory.items();
    if (items.length === 0) { bot.chat("My inventory is empty."); return true; }
    for (const item of items) {
      try { await bot.tossStack(item); } catch (_) {}
    }
    bot.chat('Dropped everything.');
    return true;
  }

  // Drop held
  if (/\b(drop (the item |it )?in (your|my) hand|drop what you('re| are) holding|larga o que est[aá] segurando|joga isso fora)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try { await bot.tossStack(held); bot.chat(`Dropped ${itemLabel(held)}.`); }
    catch (_) { bot.chat("Couldn't drop that."); }
    return true;
  }

  // Fetch from storage: "bring me X", "get me X", "fetch X [from storage]"
  {
    const SKIP = new Set(['that', 'this', 'it', 'isso', 'aqui', 'esse', 'essa']);
    const m = lower.match(
      /\b(?:bring|fetch|retrieve|grab)\s+(?:me\s+)?(?:some\s+|an?\s+)?(.+?)(?:\s+from\s+\S.*)?\s*$|(?:get\s+me\s+)(?:some\s+|an?\s+)?(.+?)(?:\s+from\s+\S.*)?\s*$/
    );
    if (m) {
      let rawQ = (m[1] || m[2] || '').trim();
      if (rawQ && !SKIP.has(rawQ)) {
        const countM = rawQ.match(/^(\d+)\s+(.+)$/);
        let takeCount = 64;
        if (countM) { takeCount = parseInt(countM[1]); rawQ = countM[2].trim(); }
        const query   = rawQ.replace(/\s+/g, '_').toLowerCase();
        const querySg = query.endsWith('s') ? query.slice(0, -1) : query;

        const matchItem = i => {
          const n = i.name.toLowerCase();
          return n.includes(query) || n.includes(querySg)
              || (i.displayName || '').toLowerCase().includes(rawQ);
        };

        const owned = bot.inventory.items().find(matchItem);
        if (owned) { bot.chat(`I already have ${owned.count}x ${itemLabel(owned)}.`); return true; }

        const containers = findNearbyContainers(bot);
        if (!containers.length) { bot.chat("I don't see any storage nearby."); return true; }

        bot.chat(`Searching ${containers.length} container(s) for "${rawQ}"...`);
        state.isLooting = true;
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);

        (async () => {
          try {
            for (const block of containers) {
              const p = block.position;
              try {
                await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));
                const win = await bot.openContainer(block);
                const found = win.containerItems().find(matchItem);
                if (found) {
                  await win.withdraw(found.type, null, Math.min(found.count, takeCount));
                  win.close();
                  const got = bot.inventory.items().find(matchItem);
                  bot.chat(`Got ${got ? got.count : found.count}x ${itemLabel(found)}.`);
                  return;
                }
                win.close();
              } catch (err) {
                console.error(`[STORAGE] ${block.name} at ${p.x},${p.y},${p.z}: ${err.message}`);
              }
            }
            bot.chat(`"${rawQ}" not found in any nearby storage.`);
          } finally {
            state.isLooting = false;
          }
        })();
        return true;
      }
    }
  }

  // Drop/give named item
  {
    const dropMatch = raw.match(/\b(?:drop|give|toss|throw)(?:\s+me)?\s+(?:your\s+|the\s+|some\s+|a\s+|an\s+)?(\w+)/i)
                   || raw.match(/\b(?:me\s+(?:dá|da|passa|joga|manda|larga)|larga\s+(?:o|a|os|as|um|uma)?\s*)(\w+)/i);
    if (dropMatch) {
      const itemName = dropMatch[1].toLowerCase();
      const item     = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName));
      if (!item) { bot.chat(`I don't have any ${itemName}.`); return true; }
      try { await bot.tossStack(item); bot.chat(`Dropped ${item.count}x ${itemLabel(item)}.`); }
      catch (err) { console.error(`[NILO] Drop failed for ${itemLabel(item)}:`, err.message); bot.chat("Couldn't drop that."); }
      return true;
    }
  }

  // Eat this
  if (/\b(eat (this|that|it)|come (isso|esse|essa|aqui|ele|ela))\b/.test(lower)) {
    await pickupNearestItem(bot, 8);
    const food = bot.inventory.items().find(i => bot.registry.foodsByName[i.name]);
    if (!food) { bot.chat("I don't have anything to eat."); return true; }
    try { await bot.equip(food, 'hand'); await bot.consume(); bot.chat(`Ate ${food.name}.`); }
    catch (_) { bot.chat("Couldn't eat that."); }
    return true;
  }

  return false;
}

module.exports = { handle, itemLabel };
