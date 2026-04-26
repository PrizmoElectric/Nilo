// activities.js — farming, fishing, building, dancing, sleeping, grave pickup

const Vec3 = require('vec3');
const { goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const state  = require('./state');
const { setBehavior, clearBehavior } = require('./behavior');
const { createMovements } = require('./movement');
const { isBuildable } = require('./items');
const { loadConfig } = require('./config');
const { MASTER, MATURE_CROPS } = require('./config');
const { getModdedBlockName, setManualOverride } = require('./registry-patch');

// ── Farming ───────────────────────────────────────────────────────────────────

async function runFarm(bot) {
  if (state.isFarming) {
    bot.chat('Already farming. Give me a moment.');
    return;
  }

  const cfg = loadConfig();
  if (!cfg.farm || !cfg.chest) {
    bot.chat('No farm or chest set. Use !nilo setfarm and !nilo setchest first.');
    return;
  }

  state.isFarming = true;
  bot.chat('Heading to the farm.');
  console.log('[NILO] Starting farm run.');

  try {
    const { farm, chest } = cfg;
    const mcData    = require('minecraft-data')(bot.version);
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);

    // Walk to the farm area centre
    const cx = Math.floor((farm.x1 + farm.x2) / 2);
    const cy = Math.min(farm.y1, farm.y2);
    const cz = Math.floor((farm.z1 + farm.z2) / 2);
    await bot.pathfinder.goto(new GoalBlock(cx, cy, cz));

    // Scan for mature crops inside the bounding box
    const minX = Math.min(farm.x1, farm.x2);
    const maxX = Math.max(farm.x1, farm.x2);
    const minY = Math.min(farm.y1, farm.y2);
    const maxY = Math.max(farm.y1, farm.y2);
    const minZ = Math.min(farm.z1, farm.z2);
    const maxZ = Math.max(farm.z1, farm.z2);

    const matureBlocks = [];
    for (const [cropName, { age }] of Object.entries(MATURE_CROPS)) {
      const blockType = mcData.blocksByName[cropName];
      if (!blockType) continue;

      const found = bot.findBlocks({
        matching: (block) => block.name === cropName && block.getProperties().age === age,
        maxDistance: 128,
        count: 256,
      }).filter(pos =>
        pos.x >= minX && pos.x <= maxX &&
        pos.y >= minY && pos.y <= maxY &&
        pos.z >= minZ && pos.z <= maxZ
      );

      matureBlocks.push(...found);
    }

    if (matureBlocks.length === 0) {
      bot.chat('Nothing is ready to harvest yet.');
      state.isFarming = false;
      return;
    }

    console.log(`[NILO] Found ${matureBlocks.length} mature crop(s).`);

    // Harvest each block
    for (const pos of matureBlocks) {
      const block = bot.blockAt(pos);
      if (!block) continue;
      await bot.collectBlock.collect(block);
    }

    // Walk to chest and deposit
    bot.chat('Harvest done. Taking it to the chest.');
    await bot.pathfinder.goto(new GoalBlock(chest.x, chest.y, chest.z));

    const targetBlock = bot.blockAt({ x: chest.x, y: chest.y, z: chest.z });
    if (targetBlock && targetBlock.name.includes('chest')) {
      const chestContainer = await bot.openContainer(targetBlock);
      const harvestItems = ['wheat', 'carrot', 'potato', 'beetroot'];
      for (const item of bot.inventory.items()) {
        if (harvestItems.includes(item.name)) {
          await chestContainer.deposit(item.type, null, item.count);
        }
      }
      chestContainer.close();
    }

    bot.chat('All done. Farm run complete.');
    console.log('[NILO] Farm run complete.');
  } catch (err) {
    console.error('[NILO] Farm error:', err.message);
    bot.chat('Something went wrong during the farm run.');
  }

  state.isFarming = false;
}

// ── Grave pickup ──────────────────────────────────────────────────────────────

async function collectGrave(bot) {
  clearBehavior(bot);

  function isGraveBlock(b) {
    const name = (b.name ?? '').toLowerCase();
    if (name === 'gravel') return false;
    // Direct stateId match for yigd:grave (fallback before registry is patched)
    if (b.stateId === 588209) return true;
    // Named modded blocks
    if (name.includes(':') && (name.includes('grave') || name.includes('tombstone') || name.includes('coffin') || name.includes('soulstone'))) return true;
    if (['gravestone','tombstone'].some(k => name.includes(k))) return true;
    // Unnamed/unknown modded blocks — mineflayer can't resolve the registry name for
    // many Fabric mods. Match any block with an empty or 'unknown' name that has a
    // non-empty bounding box (i.e. it's a real solid/interactable block, not air).
    if ((name === '' || name === 'unknown') && b.boundingBox && b.boundingBox !== 'empty') return true;
    return false;
  }

  // Log unknown-named blocks nearby to help identify the grave type ID
  const unknownBlocks = [];
  bot.findBlock({ matching: b => {
    if ((b.name === '' || b.name === 'unknown') && b.boundingBox !== 'empty' && unknownBlocks.length < 5) {
      unknownBlocks.push(`type=${b.type} stateId=${b.stateId} at ${b.position}`);
    }
    return false;
  }, maxDistance: 64 });
  if (unknownBlocks.length) console.log('[NILO] Unknown modded blocks nearby:', unknownBlocks.join(' | '));

  const grave = bot.findBlock({
    matching: b => {
      const match = isGraveBlock(b);
      if (match) console.log(`[NILO] Found grave block: "${b.name}" type=${b.type} at ${b.position}`);
      return match;
    },
    maxDistance: 200,
  });

  if (!grave) {
    const modded = [];
    bot.findBlock({ matching: b => {
      if (b.name.includes(':') && modded.length < 30) modded.push(b.name);
      return false;
    }, maxDistance: 64 });
    console.log('[NILO] No grave found. Nearby modded blocks:', [...new Set(modded)].join(', ') || 'none');
    bot.chat("I can't find my grave nearby.");
    return;
  }

  const p = grave.position;
  bot.chat(`Found it. Going to ${p.x}, ${p.y}, ${p.z}.`);

  try {
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);

    // GoalNear only checks XZ distance — navigate to an adjacent block at the
    // correct Y level so the bot is always within reach regardless of elevation.
    const adjacent = [
      new Vec3(p.x + 1, p.y, p.z),
      new Vec3(p.x - 1, p.y, p.z),
      new Vec3(p.x, p.y, p.z + 1),
      new Vec3(p.x, p.y, p.z - 1),
    ];
    let reached = false;
    for (const adj of adjacent) {
      try {
        await bot.pathfinder.goto(new GoalBlock(adj.x, adj.y, adj.z));
        reached = true;
        break;
      } catch (_) {}
    }
    if (!reached) {
      // Last resort: standard GoalNear in case all adjacent blocks are impassable
      await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));
    }

    // Re-fetch the block after navigation — the pre-nav reference can be stale
    const freshGrave = bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (!freshGrave || !isGraveBlock(freshGrave)) {
      bot.chat("The grave disappeared before I could collect it.");
      console.log('[NILO] Grave block gone after navigation. Was:', grave.name);
      return;
    }

    await new Promise(r => setTimeout(r, 200)); // let physics settle

    // Try opening as a container (YIGD exposes grave as inventory)
    try {
      const container = await bot.openContainer(freshGrave);
      const items = container.containerItems();
      for (const item of items) {
        try { await container.withdraw(item.type, null, item.count); } catch (_) {}
      }
      container.close();
      bot.chat(`Got my stuff back (${items.length} stacks).`);
      console.log(`[NILO] Collected grave (${items.length} item stacks).`);
      return;
    } catch (containerErr) {
      console.log('[NILO] openContainer failed:', containerErr.message, '— trying sneak+right-click');
    }

    // Fallback: sneak + right-click (some YIGD versions auto-collect on sneak)
    bot.setControlState('sneak', true);
    await bot.lookAt(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5), true);
    await bot.activateBlock(freshGrave);
    await new Promise(r => setTimeout(r, 800));
    bot.setControlState('sneak', false);
    bot.chat('Tried to collect the grave.');
    console.log('[NILO] Activated grave block (sneak fallback).');
  } catch (err) {
    console.error('[NILO] Grave collect error:', err.message);
    bot.chat("Something went wrong trying to get my grave.");
  }
}

// ── Fishing ───────────────────────────────────────────────────────────────────

async function startFishing(bot) {
  const rod = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
  if (!rod) { bot.chat("I don't have a fishing rod."); return; }

  setBehavior(bot, 'fishing', MASTER);
  bot.chat('Casting the line...');

  try { await bot.equip(rod, 'hand'); } catch (_) {}

  let bobber   = null;
  let castTime = 0;

  const onEntitySpawn = (entity) => {
    const { BOT_USERNAME } = require('./config');
    if (entity.name === 'fishing_bobber' && entity.username === BOT_USERNAME) {
      bobber = entity;
    }
  };
  const onCollect = (collector) => {
    const { BOT_USERNAME } = require('./config');
    if (collector.username === BOT_USERNAME && state.behaviorMode === 'fishing') {
      bot.chat('Got something!');
    }
  };
  bot.on('entitySpawn', onEntitySpawn);
  bot.on('playerCollect', onCollect);

  const recast = async () => {
    if (state.behaviorMode !== 'fishing') {
      bot.removeListener('entitySpawn', onEntitySpawn);
      bot.removeListener('playerCollect', onCollect);
      return;
    }
    try {
      const r = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
      if (!r) { bot.chat('No fishing rod left.'); setBehavior(bot, 'idle', MASTER); return; }
      await bot.equip(r, 'hand');
      bot.activateItem(); // cast / reel
      castTime = Date.now();
      bobber = null;
    } catch (err) {
      console.error('[NILO] Fishing cast error:', err.message);
    }
    // Wait 20-40s then reel in and recast regardless
    const wait = 20000 + Math.random() * 20000;
    setTimeout(async () => {
      if (state.behaviorMode !== 'fishing') return;
      bot.activateItem(); // reel in
      await new Promise(r => setTimeout(r, 600));
      recast();
    }, wait);
  };

  // Initial cast
  bot.activateItem();
  castTime = Date.now();
  const wait = 20000 + Math.random() * 20000;
  setTimeout(async () => {
    if (state.behaviorMode !== 'fishing') return;
    bot.activateItem(); // reel in
    await new Promise(r => setTimeout(r, 600));
    recast();
  }, wait);

  // Watch for bobber dipping (entity velocity sudden downward spike)
  state.behaviorInterval = setInterval(() => {
    if (state.behaviorMode !== 'fishing') {
      clearInterval(state.behaviorInterval);
      state.behaviorInterval = null;
      bot.removeListener('entitySpawn', onEntitySpawn);
      bot.removeListener('playerCollect', onCollect);
      return;
    }
    if (!bobber) return;
    if (bobber.velocity && bobber.velocity.y < -0.2 && Date.now() - castTime > 3000) {
      bot.activateItem(); // reel in
      castTime = Date.now() + 99999; // prevent double-reel
      setTimeout(async () => {
        if (state.behaviorMode !== 'fishing') return;
        await new Promise(r => setTimeout(r, 600));
        recast();
      }, 500);
    }
  }, 200);
}

// ── Building ──────────────────────────────────────────────────────────────────

async function tryPlaceBlock(bot, x, y, z) {
  const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  const cur    = bot.blockAt(target);
  if (cur && cur.name !== 'air' && cur.name !== 'cave_air') return true; // already there

  const faces = [
    { offset: new Vec3(0,-1,0), face: new Vec3(0,1,0) },
    { offset: new Vec3(0,1,0),  face: new Vec3(0,-1,0) },
    { offset: new Vec3(1,0,0),  face: new Vec3(-1,0,0) },
    { offset: new Vec3(-1,0,0), face: new Vec3(1,0,0) },
    { offset: new Vec3(0,0,1),  face: new Vec3(0,0,-1) },
    { offset: new Vec3(0,0,-1), face: new Vec3(0,0,1) },
  ];
  for (const { offset, face } of faces) {
    const refPos = target.plus(offset);
    const ref    = bot.blockAt(refPos);
    if (!ref || ref.name === 'air' || ref.name === 'cave_air') continue;
    try {
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 3));
      await bot.lookAt(target, true);
      await bot.placeBlock(ref, face);
      return true;
    } catch (_) {}
  }
  return false;
}

async function buildSimpleHouse(bot) {
  const material = bot.inventory.items().find(isBuildable);
  if (!material) { bot.chat("I don't have any building materials."); return; }

  setBehavior(bot, 'building', MASTER);
  bot.chat('Building a quick shelter...');

  const o = bot.entity.position.floored();

  // Build order: floor first, then walls bottom-up, then roof
  const positions = [];

  // Floor (Y-1)
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      positions.push({ x: o.x+x, y: o.y-1, z: o.z+z });

  // Walls — perimeter, 3 high; leave a 1×2 entrance on south (z=+2, x=0)
  for (let h = 0; h <= 2; h++) {
    for (let i = -2; i <= 2; i++) {
      positions.push({ x: o.x+i, y: o.y+h, z: o.z-2 }); // north
      if (!(i === 0 && h <= 1)) positions.push({ x: o.x+i, y: o.y+h, z: o.z+2 }); // south (door gap)
      if (i > -2 && i < 2) {
        positions.push({ x: o.x-2, y: o.y+h, z: o.z+i }); // west
        positions.push({ x: o.x+2, y: o.y+h, z: o.z+i }); // east
      }
    }
  }

  // Roof (Y+3)
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      positions.push({ x: o.x+x, y: o.y+3, z: o.z+z });

  let placed = 0;
  for (const pos of positions) {
    if (state.behaviorMode !== 'building') break;
    const mat = bot.inventory.items().find(isBuildable);
    if (!mat) { bot.chat('Ran out of building materials.'); break; }
    try {
      await bot.equip(mat, 'hand');
      const ok = await tryPlaceBlock(bot, pos.x, pos.y, pos.z);
      if (ok) placed++;
    } catch (err) {
      console.error('[NILO] Build error:', err.message);
    }
  }

  if (state.behaviorMode === 'building') {
    setBehavior(bot, 'idle', MASTER);
    bot.chat(`Done! Placed ${placed} blocks.`);
  }
}

// ── Dance ─────────────────────────────────────────────────────────────────────

function startDance(bot) {
  setBehavior(bot, 'dance', MASTER);
  bot.chat('*starts dancing*');

  let tick = 0;
  bot.clearControlStates();

  state.behaviorInterval = setInterval(() => {
    if (state.behaviorMode !== 'dance') return;

    tick++;
    const t = tick % 40; // 40-tick (~2s) cycle at 50ms interval

    if (tick % 4 === 0) bot.swingArm();

    if (t < 10) {
      bot.clearControlStates();
      bot.setControlState('jump', t % 2 === 0);
      bot.look((bot.entity.yaw + 0.35) % (Math.PI * 2), 0.2, false);
    } else if (t < 20) {
      bot.clearControlStates();
      bot.setControlState('right', true);
      bot.setControlState('sneak', t % 4 < 2);
      bot.setControlState('jump', t % 4 >= 2);
    } else if (t < 30) {
      bot.clearControlStates();
      bot.setControlState('jump', t % 3 === 0);
      bot.look((bot.entity.yaw - 0.35 + Math.PI * 2) % (Math.PI * 2), -0.1, false);
    } else {
      bot.clearControlStates();
      bot.setControlState('left', true);
      bot.setControlState('jump', t % 3 === 0);
    }
  }, 50);
}

// ── Sleep in bed ──────────────────────────────────────────────────────────────

async function sleepInBed(bot) {
  // Primary search: vanilla registry name
  let bed = bot.findBlock({
    matching: b => b.name.endsWith('_bed'),
    maxDistance: 48,
  });

  // Fallback: search by modded-name mapping
  if (!bed) {
    bed = bot.findBlock({
      matching: b => {
        const mapped = getModdedBlockName(b.stateId);
        return !!(mapped && mapped.endsWith('_bed'));
      },
      maxDistance: 48,
    });
    if (bed) {
      // Fix the registry permanently — mineflayer's bot.sleep validates block.name
      const mapped = getModdedBlockName(bed.stateId);
      setManualOverride(bot, bed.stateId, mapped);
      bed = bot.blockAt(bed.position); // re-fetch with patched registry
      console.log(`[NILO] Fixed bed registry: stateId ${bed.stateId} → ${mapped}`);
    }
  }

  if (!bed) { bot.chat("I don't see a bed nearby."); return; }

  clearBehavior(bot);
  const bp = bed.position;
  bot.pathfinder.setMovements(createMovements(bot));
  try {
    const adjacent = [
      new Vec3(bp.x + 1, bp.y, bp.z),
      new Vec3(bp.x - 1, bp.y, bp.z),
      new Vec3(bp.x, bp.y, bp.z + 1),
      new Vec3(bp.x, bp.y, bp.z - 1),
    ];
    let reached = false;
    for (const adj of adjacent) {
      try { await bot.pathfinder.goto(new GoalBlock(adj.x, adj.y, adj.z)); reached = true; break; }
      catch (_) {}
    }
    if (!reached) await bot.pathfinder.goto(new GoalNear(bp.x, bp.y, bp.z, 2));

    const freshBed = bot.blockAt(new Vec3(bp.x, bp.y, bp.z));
    if (!freshBed || !freshBed.name.endsWith('_bed')) {
      bot.chat("I can't find the bed anymore.");
      return;
    }
    await bot.sleep(freshBed);
    bot.chat('Goodnight...');
  } catch (err) {
    bot.chat(`Can't sleep: ${err.message}`);
    console.error('[NILO] Sleep error:', err.message);
  }
}

// ── Sign writing ──────────────────────────────────────────────────────────────
// writeSign(bot, text) — place a sign and write text on it.
// wrapSignText(text)   — split a string into 4 lines of max 15 chars each.

function wrapSignText(text) {
  const words = text.split(/\s+/);
  const lines = ['', '', '', ''];
  let   li    = 0;

  for (const word of words) {
    if (li >= 4) break;
    const candidate = lines[li] ? `${lines[li]} ${word}` : word;
    if (candidate.length <= 15) {
      lines[li] = candidate;
    } else if (word.length <= 15) {
      li++;
      if (li < 4) lines[li] = word;
    } else {
      // Hard-split long word
      let remaining = word;
      while (remaining && li < 4) {
        const space  = 15 - lines[li].length - (lines[li] ? 1 : 0);
        const chunk  = remaining.slice(0, lines[li] ? space - 1 : space);
        lines[li]    = lines[li] ? `${lines[li]} ${chunk}` : chunk;
        remaining    = remaining.slice(chunk.length);
        if (remaining) li++;
      }
    }
  }

  return lines;
}

async function writeSign(bot, text) {
  // Find a sign in inventory
  const signItem = bot.inventory.items().find(i =>
    i.name.endsWith('_sign') || i.name === 'sign'
  );
  if (!signItem) {
    bot.chat("I don't have any signs.");
    return false;
  }

  // Find a solid block on the ground to place the sign on
  const pos   = bot.entity.position.floored();
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below || below.name === 'air') {
    bot.chat("Nowhere to place a sign here.");
    return false;
  }

  try {
    await bot.equip(signItem, 'hand');
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    await new Promise(r => setTimeout(r, 200));

    // Find the newly placed sign
    const signBlock = bot.findBlock({
      matching: b => b.name.endsWith('_sign') || b.name === 'sign',
      maxDistance: 4,
    });
    if (!signBlock) {
      bot.chat("Placed a sign but couldn't find it to write on.");
      return false;
    }

    const lines = wrapSignText(text);
    await bot.updateSign(signBlock, lines, true); // true = front face
    console.log(`[NILO] Sign written: ${lines.filter(Boolean).join(' | ')}`);
    return true;
  } catch (err) {
    bot.chat("Couldn't write the sign.");
    console.error('[SIGN]', err.message);
    return false;
  }
}

module.exports = {
  runFarm, collectGrave, startFishing,
  tryPlaceBlock, buildSimpleHouse,
  startDance, sleepInBed,
  writeSign, wrapSignText,
};
