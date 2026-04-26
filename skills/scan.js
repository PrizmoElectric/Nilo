const fs   = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const state = require('../state');
const { getModdedBlockName } = require('../registry-patch');

/**
 * runScan - Scans the surrounding area for blocks and their State IDs.
 * Optimized for Prominence II to detect registry-shifted or modded blocks.
 */
async function runScan(bot, raw) {
  const radiusMatch = raw.match(/\b(\d+)\b/);
  const radius = Math.min(Math.max(parseInt(radiusMatch?.[1] ?? '16', 10), 1), 64);
  const debug  = /\bdebug\b/.test(raw);

  bot.chat(`Scanning ${radius}-block radius...`);

  const pos    = bot.entity.position.floored();
  const counts = {};
  const SKIP   = new Set(['air', 'cave_air', 'void_air', 'unknown']);

  // Triple loop to cover the radius
  for (let x = pos.x - radius; x <= pos.x + radius; x++) {
    for (let y = Math.max(-64, pos.y - radius); y <= Math.min(320, pos.y + radius); y++) {
      for (let z = pos.z - radius; z <= pos.z + radius; z++) {

        const pos3 = new Vec3(x, y, z);
        const sid = bot.world.getBlockStateId(pos3);

        // Immediate skip for air (ID 0) to save performance
        if (sid === 0) continue;

        const b = bot.blockAt(pos3);
        let name;

        // 1. Resolve Name: Registry -> Modded Mapper -> "unknown"
        if (b && b.name && b.name !== 'unknown' && b.name !== '') {
          name = b.name;
        } else {
          const modName = getModdedBlockName(sid);
          name = modName || 'unknown';
        }

        // 2. Filter out air types and persistent unknowns
        if (SKIP.has(name)) continue;

        // 3. Format the Key: Name + State ID (Crucial for debugging desyncs)
        const key = `${name}(sid:${sid})`;

        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  if (!sorted.length) {
    bot.chat('Nothing around me (Check if chunks are loaded).');
    return null;
  }

  // Formatting Table for file output
  const colW    = Math.max(...sorted.map(([n]) => n.length), 10);
  const header  = `${'Block(StateID)'.padEnd(colW)}  Count`;
  const divider = '-'.repeat(colW) + '  -----';
  const rows    = sorted.map(([name, count]) => `${name.padEnd(colW)}  ${String(count).padStart(5)}`);
  const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const table = [
    `Scan at ${pos.x}, ${pos.y}, ${pos.z} | Radius: ${radius}`,
    `Timestamp: ${new Date().toISOString()}`,
    '',
    header,
    divider,
    ...rows,
  ].join('\n');

  // Persistence
  const scansDir = path.join(__dirname, '..', 'scans');
  if (!fs.existsSync(scansDir)) fs.mkdirSync(scansDir);
  const file = path.join(scansDir, `scan_${stamp}_r${radius}.txt`);

  try {
    fs.writeFileSync(file, table, 'utf8');
  } catch (err) {
    console.error(`[SCAN] Failed to save file: ${err.message}`);
  }

  const entry = { text: table, stamp, radius, rows: sorted };
  state.scans.unshift(entry);

  // Chat Feedback
  const top = sorted.slice(0, 8).map(([n, c]) => `${n}:${c}`).join(', ');
  bot.chat(`Top blocks: ${top}`);
  console.log(`[SCAN] Completed. Saved to ${file}`);

  return entry;
}

module.exports = { runScan };
