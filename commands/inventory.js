const { goals: { GoalNear } } = require('../pathfinder-compat');
const PrismarineItem = require('prismarine-item');
const state  = require('../state');
const { pickupNearestItem, isEquippable, getEquipDestination, resolveItemName } = require('../items');
const { equipShield } = require('../combat');
const { createMovements } = require('../movement');
const { MASTER } = require('../config');
const { cmd } = require('./_util');
const { getModdedBlockName, findBlocksByName } = require('../registry-patch');
const { findBlockPositions } = require('../skills/scan');
const { getPlayerGazeTarget } = require('../gaze');

// Equip confirmations/failures go here instead of public bot.chat() — visibly
// putting on armor is one thing, but announcing it to the whole server chat
// (and by extension Discord, since discord-bridge.js's chat wrapper skips
// mirroring anything starting with "/") isn't something MASTER wants public.
function tellMaster(bot, text) {
  bot.chat(`/msg ${MASTER} ${text}`);
}

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
  return resolveItemName(item);
}

const IS_INVENTORY = cmd([
  /\b(inventory|invent[aá]rio|what('s| is) in (your |my )?bag|what are you (carrying|holding)|o que (você |vc )?t[eê]m|mostra (o )?invent[aá]rio)\b/,
  /\b(show (me )?(your )?(inventory|items?|stuff)|list (your )?(items?|stuff))\b/,
  /\b(what do you have|what('s| is) on you|what did you pick up)\b/,
  /\b(o que (você |vc )?carrega|seus itens|mostra (seus |os )?itens)\b/,
]);

async function handle(bot, lower, raw, username) {
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

  // "open at X Y Z" — navigate to specific coordinates and interact with block there
  {
    const m = lower.match(/\bopen\s+at\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\b/);
    if (m) {
      const Vec3 = require('vec3');
      const [, bx, by, bz] = m.map(Number);
      const bpos = new Vec3(bx, by, bz);
      state.isLooting = true;
      state.manualInteractLock = true;
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      try {
        // Try each face explicitly — AE2 cable bus parts only respond when the
        // correct face direction is sent in the block_place packet.
        // Each entry: [approach offset, face direction Vec3, cursor offset within block]
        const faceTrials = [
          { ap: new Vec3(bx - 2, by, bz), face: new Vec3(-1, 0, 0), cur: new Vec3(0.1, 0.5, 0.5) }, // west face
          { ap: new Vec3(bx + 2, by, bz), face: new Vec3( 1, 0, 0), cur: new Vec3(0.9, 0.5, 0.5) }, // east face
          { ap: new Vec3(bx, by, bz - 2), face: new Vec3( 0, 0,-1), cur: new Vec3(0.5, 0.5, 0.1) }, // north face
          { ap: new Vec3(bx, by, bz + 2), face: new Vec3( 0, 0, 1), cur: new Vec3(0.5, 0.5, 0.9) }, // south face
          { ap: new Vec3(bx, by + 2, bz), face: new Vec3( 0,-1, 0), cur: new Vec3(0.5, 0.9, 0.5) }, // bottom face (from above)
        ];
        let rawData = null;
        const block = bot.blockAt(bpos);
        const label = block ? (getModdedBlockName(block.stateId) || block.name || `${bx},${by},${bz}`) : `${bx},${by},${bz}`;

        for (const { ap, face, cur } of faceTrials) {
          try {
            await bot.pathfinder.goto(new GoalNear(ap.x, ap.y, ap.z, 2));
          } catch (_) { /* try next direction if unreachable */ }
          await bot.lookAt(bpos.offset(0.5, 0.5, 0.5), true);

          const p = new Promise(resolve => {
            let done = false;
            const onWI = (packet) => {
              if (!done && packet.windowId !== 0) {
                done = true;
                bot._client.removeListener('window_items', onWI);
                resolve({ windowId: packet.windowId, items: packet.items });
              }
            };
            bot._client.on('window_items', onWI);
            setTimeout(() => { if (!done) { done = true; bot._client.removeListener('window_items', onWI); resolve(null); } }, 3000);
          });

          if (block) await bot.activateBlock(block, face, cur);
          await new Promise(r => setTimeout(r, 200));
          rawData = await p;
          if (rawData) break;  // opened successfully from this direction
        }
        if (rawData) try { bot._client.write('close_window', { windowId: rawData.windowId }); } catch (_) {}

        state.isLooting = false; state.manualInteractLock = false;
        if (rawData) {
          const Item = PrismarineItem(bot.registry);
          const allSlots = rawData.items || [];
          const containerSlots = allSlots.length > 36 ? allSlots.slice(0, allSlots.length - 36) : allSlots;
          const items = containerSlots
            .map(raw => { try { return Item.fromNotch(raw); } catch (_) { return null; } })
            .filter(i => i !== null && i.type !== -1 && i.type !== 0);
          const nameOf = (i) => {
            if (i.customName) return i.customName.replace(/§./g, '');
            return resolveItemName(i);
          };
          if (!items.length) bot.chat(`${label}: empty.`);
          else {
            const summary = items.slice(0, 8).map(i => `${i.count}x ${nameOf(i)}`).join(', ');
            const more = items.length > 8 ? ` (+${items.length - 8} more)` : '';
            bot.chat(`${label}: ${summary}${more}`);
          }
        } else {
          bot.chat(`Interacted with ${label} (no window — may be a cable or unsupported block).`);
        }
      } catch (err) {
        state.isLooting = false; state.manualInteractLock = false;
        bot.chat(`Couldn't reach ${bx},${by},${bz}: ${err.message}`);
      }
      return true;
    }
  }

  // "open [block name]" — find nearest block matching name, walk to it, interact
  // Handles: "open ae2 terminal", "open the inscriber", "open ae2:charger", "find ae2 block"
  {
    const m = lower.match(/\b(?:open|find(?: and open)?|go to(?: the)?|interact with)\s+(?:the\s+|nearest\s+)?([a-z0-9_]+(?::[a-z0-9_]+)?(?:\s+[a-z0-9_]+)*)\s*$/);
    if (m) {
      // Normalise: "ae2 drive" → "ae2:drive", "techreborn lead ore" → "techreborn:lead_ore"
      let rawQ = m[1].trim();
      const spaceIdx = rawQ.indexOf(' ');
      if (spaceIdx !== -1 && !rawQ.includes(':')) {
        // treat first word as mod namespace: "ae2 drive" → "ae2:drive"
        rawQ = rawQ.slice(0, spaceIdx) + ':' + rawQ.slice(spaceIdx + 1).replace(/\s+/g, '_');
      } else {
        rawQ = rawQ.replace(/\s+/g, '_');
      }
      // Only trigger for block-like queries (contains colon, or is a known modded keyword)
      const isModdedQuery = rawQ.includes(':') || /^(inscriber|charger|drive|terminal|controller|cable)/.test(rawQ);
      // Avoid stealing vanilla commands like "open chest", "open box"
      const isVanilla = /^(chest|barrel|box|container|storage)$/.test(rawQ);
      if (isModdedQuery && !isVanilla) {
        state.isLooting = true;       // block autonomous container search
        state.manualInteractLock = true; // prevent autonomous task from clearing isLooting
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);

        let positions = findBlockPositions(bot, rawQ, 64, 10);

        // If nothing found in loaded chunks, navigate toward the last scan center first
        if (!positions.length && state.scans?.[0]) {
          const sc = state.scans[0];
          // Extract center from scan text header: "Scan at X, Y, Z | Radius: N"
          const hdr = sc.text?.split('\n')[0] || '';
          const hm = hdr.match(/Scan at (-?\d+), (-?\d+), (-?\d+)/);
          if (hm) {
            const [, sx, sy, sz] = hm.map(Number);
            bot.chat(`No "${rawQ}" nearby — heading to last scan area to look...`);
            try {
              await bot.pathfinder.goto(new GoalNear(sx, sy, sz, 8));
              // Wait for chunks to finish loading after arriving
              for (let attempt = 0; attempt < 3 && !positions.length; attempt++) {
                await new Promise(r => setTimeout(r, 2000));
                positions = findBlockPositions(bot, rawQ, 48, 10);
              }
            } catch (_) {}
          }
        }

        if (!positions.length) {
          state.isLooting = false; state.manualInteractLock = false;
          bot.chat(`No "${rawQ}" found within scan range.`);
          return true;
        }
        bot.chat(`Found ${positions.length} "${rawQ}" block(s). Heading to the nearest...`);

        const Item = PrismarineItem(bot.registry);

        for (const bpos of positions) {
          const block = bot.blockAt(bpos);
          if (!block) continue;
          try {
            await bot.pathfinder.goto(new GoalNear(bpos.x, bpos.y, bpos.z, 3));
            await bot.lookAt(bpos.offset(0.5, 0.5, 0.5), true);

            // AE2 and other modded blocks use custom container types that mineflayer's
            // createWindow can't handle (returns null for unknown types in 1.20.1).
            // Intercept the raw window_items packet directly and parse items ourselves.
            const rawItemsPromise = new Promise(resolve => {
              let resolved = false;
              const onWindowItems = (packet) => {
                if (!resolved && packet.windowId !== 0) {
                  resolved = true;
                  bot._client.removeListener('window_items', onWindowItems);
                  resolve({ windowId: packet.windowId, items: packet.items });
                }
              };
              bot._client.on('window_items', onWindowItems);
              setTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  bot._client.removeListener('window_items', onWindowItems);
                  resolve(null);
                }
              }, 6000);
            });

            await bot.activateBlock(block);
            await new Promise(r => setTimeout(r, 300)); // give server time to send window
            const rawData = await rawItemsPromise;

            // Close the window server-side
            if (rawData) {
              try { bot._client.write('close_window', { windowId: rawData.windowId }); } catch (_) {}
            }

            state.isLooting = false; state.manualInteractLock = false;
            const label = block.name || rawQ;
            if (rawData) {
              const allSlots = rawData.items || [];
              console.log(`[ITEM] Window ${rawData.windowId}: ${allSlots.length} total slots`);
              // Exclude the trailing 36 player-inventory slots common to all container windows
              const containerSlots = allSlots.length > 36
                ? allSlots.slice(0, allSlots.length - 36)
                : allSlots;

              const items = containerSlots
                .map(raw => { try { return Item.fromNotch(raw); } catch (_) { return null; } })
                .filter(i => i !== null && i.type !== -1 && i.type !== 0);

              const nameOf = (i) => {
                if (i.customName) return i.customName.replace(/§./g, '');
                return resolveItemName(i);
              };

              if (!items.length) {
                bot.chat(`${label}: empty.`);
              } else {
                const summary = items.slice(0, 8).map(i => `${i.count}x ${nameOf(i)}`).join(', ');
                const more = items.length > 8 ? ` (+${items.length - 8} more)` : '';
                bot.chat(`${label}: ${summary}${more}`);
              }
            } else {
              bot.chat(`Interacted with ${label} (no window opened — may be a cable or unsupported part).`);
            }
            return true;
          } catch (err) {
            console.error(`[NILO] find-open ${rawQ} at ${bpos}: ${err.message}`);
          }
        }
        state.isLooting = false; state.manualInteractLock = false;
        bot.chat(`Couldn't interact with any "${rawQ}" nearby.`);
        return true;
      }
    }
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
    if (!item) { tellMaster(bot, "Nothing equippable on me."); return true; }
    const dest = getEquipDestination(item);
    try {
      await bot.equip(item, dest);
      tellMaster(bot, `Equipped ${itemLabel(item)}.`);
      if (dest === 'hand' && (state.behaviorMode === 'attack' || state.behaviorMode === 'defensive')) equipShield(bot);
    } catch (_) { tellMaster(bot, "Couldn't equip that."); }
    return true;
  }

  // Equip named item — "equip iron_sword", "equip my bow"
  {
    const SKIP = ['this', 'that', 'isso', 'esse', 'essa', 'aqui', 'it'];
    const m = lower.match(/\b(?:equip|hold|wield|equipar?|segura(?:r)?|p[õo]e na m[ãa]o|coloca na m[ãa]o)\b\s+(?:(?:my|the|your|a|an|o|a|um|uma)\s+)?["']?([a-z0-9_][a-z0-9_ ]*?)["']?\s*$/);
    if (m && !SKIP.includes(m[1].trim())) {
      const query = m[1].trim().replace(/\s+/g, '_');
      const inv   = bot.inventory.items();
      // resolveItemName checks the modded registry too — i.name is 'unknown' for modded items.
      const item  = inv.find(i => resolveItemName(i).includes(query))
                 ?? inv.find(i => query.split('_').every(w => resolveItemName(i).includes(w)));
      if (!item) { tellMaster(bot, `I don't have a ${query}.`); return true; }
      const dest = getEquipDestination(item);
      try {
        await bot.equip(item, dest);
        tellMaster(bot, `Equipped ${itemLabel(item)}.`);
        if (dest === 'hand' && (state.behaviorMode === 'attack' || state.behaviorMode === 'defensive')) equipShield(bot);
      } catch (_) { tellMaster(bot, `Couldn't equip ${itemLabel(item)}.`); }
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

  // !give SLOT [COUNT] — toss item by Solsai/MC slot number (sent by inventory screen)
  {
    const m = lower.match(/^give\s+(\d+)(?:\s+(\d+))?$/);
    if (m) {
      const solsaiSlot = parseInt(m[1]);
      // Convert Solsai PlayerInventory slot → mineflayer window slot ID
      let mfSlot;
      if (solsaiSlot >= 0 && solsaiSlot <= 8)   mfSlot = solsaiSlot + 36; // hotbar: 0-8 → 36-44
      else if (solsaiSlot >= 9 && solsaiSlot <= 35) mfSlot = solsaiSlot;  // main: same
      else if (solsaiSlot === 36) mfSlot = 8;  // boots
      else if (solsaiSlot === 37) mfSlot = 7;  // legs
      else if (solsaiSlot === 38) mfSlot = 6;  // chest
      else if (solsaiSlot === 39) mfSlot = 5;  // head
      else if (solsaiSlot === 40) mfSlot = 45; // offhand
      else mfSlot = solsaiSlot;
      const item = bot.inventory.slots[mfSlot];
      if (!item) { bot.chat(`Slot ${solsaiSlot} is empty.`); return true; }
      const count = m[2] ? Math.min(parseInt(m[2]), item.count) : item.count;
      try {
        const player = bot.players[username]?.entity;
        if (player) {
          const movements = createMovements(bot);
          bot.pathfinder.setMovements(movements);
          await bot.pathfinder.goto(new GoalNear(player.position.x, player.position.y, player.position.z, 2));
        }
        await bot.toss(item.type, null, count);
        bot.chat(`Dropped ${count}x ${itemLabel(item)}.`);
      } catch (err) {
        bot.chat(`Couldn't drop slot ${solsaiSlot}: ${err.message}`);
      }
      return true;
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
