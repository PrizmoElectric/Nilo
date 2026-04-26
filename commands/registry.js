const Vec3 = require('vec3');
const state = require('../state');
const { getModdedBlockName, setManualOverride, getStateIdsByName } = require('../registry-patch');
const { runScan } = require('../skills/scan');
const { cmd } = require('./_util');

const IS_SCAN_BLOCKS = cmd([
  /\bscan\b/,
  /\bwhat (blocks?|is around|do you see|can you see)\b/,
  /\bescaneie?\b/, /\bvarre(r|ia)?\b/, /\bo que (tem|h[aá]) ao redor\b/,
  /\bquais blocos\b/, /\bblocks? (ao redor|perto)\b/,
]);
const IS_ECHO       = cmd([/\becho\b/, /\brepeat (?:the )?last\b/, /\brepete\b/]);
const IS_BLOCK_MAP  = cmd([/\bblockmap\b/, /\bmap stateId\b/, /\bidentify block\b/, /\bmapeia bloco\b/]);
// "id 1974", "where is id 1974", "find id 1974", "locate stateId 1974"
const IS_ID_LOCATE  = cmd([/\bid\s+\d+/, /\bwhere is\s+(id|stateid)\s+\d+/, /\b(find|locate)\s+(id|stateid)\s+\d+/]);

// Matches "<blockname> is [actually] <blockname>" for conversational remapping.
// Block names: lowercase letters/underscores, optional namespace (word:word).
const BLOCK_NAME = /[a-z][a-z_]*(?::[a-z][a-z_]*)*/;
const IS_BLOCK_ALIAS = new RegExp(
  `(${BLOCK_NAME.source})\\s+is\\s+(?:actually\\s+)?(${BLOCK_NAME.source})`
);

async function handle(bot, lower, raw) {
  if (IS_ECHO(lower) && /scan/.test(lower)) {
    if (!state.scans.length) { bot.chat('No scans this session. Run "scan" first.'); return true; }

    // Parse: "echo scan 0-9", "echo scan 3", "echo scan"
    const rangeMatch  = lower.match(/scan\s+(\d+)-(\d+)/);
    const singleMatch = lower.match(/scan\s+(\d+)/);

    const chatLines = [];

    if (rangeMatch) {
      // Range: show one summary line per scan
      const from = parseInt(rangeMatch[1]);
      const to   = Math.min(parseInt(rangeMatch[2]), state.scans.length - 1);
      if (from >= state.scans.length) {
        bot.chat(`Only ${state.scans.length} scan(s) available (0–${state.scans.length - 1}).`);
        return true;
      }
      chatLines.push(`Scans ${from}–${to} (0=latest):`);
      for (let i = from; i <= to; i++) {
        const { rows, radius, stamp } = state.scans[i];
        const top = (rows || []).slice(0, 3).map(([n, c]) => `${n}:${c}`).join(', ');
        chatLines.push(`[${i}] r=${radius} ${stamp} — ${top || 'empty'}`);
      }
    } else {
      // Single scan (default 0)
      const idx = singleMatch ? parseInt(singleMatch[1]) : 0;
      if (idx >= state.scans.length) {
        bot.chat(`Only ${state.scans.length} scan(s) available (0–${state.scans.length - 1}).`);
        return true;
      }
      const { rows, radius, stamp } = state.scans[idx];
      const label = idx === 0 ? 'scan 0 (latest)' : `scan ${idx}`;
      chatLines.push(`${label} r=${radius} @ ${stamp}:`);
      (rows || []).slice(0, 20).forEach(([n, c]) => chatLines.push(`  ${n}: ${c}`));
    }

    // Send one line per message, 250ms apart
    let i = 0;
    const send = () => {
      if (i >= chatLines.length) return;
      bot.chat(chatLines[i++]);
      setTimeout(send, 250);
    };
    send();
    return true;
  }

  if (IS_SCAN_BLOCKS(lower)) {
    runScan(bot, raw).catch(err => console.error('[SCAN] error:', err.message));
    return true;
  }

  if (IS_ID_LOCATE(lower)) {
    const m = raw.match(/\b(\d+)\b/);
    if (!m) { bot.chat('Usage: id <stateId>'); return true; }
    const targetSid = parseInt(m[1]);

    const pos    = bot.entity.position.floored();
    const radius = 32;
    const hits   = [];

    for (let x = pos.x - radius; x <= pos.x + radius && hits.length < 20; x++) {
      for (let y = Math.max(-64, pos.y - radius); y <= Math.min(320, pos.y + radius) && hits.length < 20; y++) {
        for (let z = pos.z - radius; z <= pos.z + radius && hits.length < 20; z++) {
          const sid = bot.world.getBlockStateId(new Vec3(x, y, z));
          if (sid === targetSid) hits.push({ x, y, z });
        }
      }
    }

    if (!hits.length) {
      bot.chat(`No block with stateId ${targetSid} found within ${radius} blocks.`);
      return true;
    }

    // Sort by distance from bot
    hits.sort((a, b) => {
      const da = Math.hypot(a.x - pos.x, a.y - pos.y, a.z - pos.z);
      const db = Math.hypot(b.x - pos.x, b.y - pos.y, b.z - pos.z);
      return da - db;
    });

    const name    = getModdedBlockName(targetSid) || bot.blockAt(new Vec3(hits[0].x, hits[0].y, hits[0].z))?.name || 'unknown';
    const chatLines = [`stateId ${targetSid} (${name}) — ${hits.length} hit(s):`];
    for (const { x, y, z } of hits.slice(0, 10)) {
      const dist = Math.round(Math.hypot(x - pos.x, y - pos.y, z - pos.z));
      chatLines.push(`  ${x} ${y} ${z}  (${dist}m away)`);
    }
    if (hits.length > 10) chatLines.push(`  ...and ${hits.length - 10} more.`);

    let i = 0;
    const send = () => { if (i >= chatLines.length) return; bot.chat(chatLines[i++]); setTimeout(send, 250); };
    send();
    return true;
  }

  if (IS_BLOCK_MAP(lower)) {
    const m = raw.match(/(\d+)\s+(\S+:\S+)/);
    if (!m) { bot.chat('Usage: blockmap <stateId> <mod:block>'); return true; }
    const stateId = parseInt(m[1]);
    const name    = m[2];
    setManualOverride(bot, stateId, name);
    bot.chat(`Mapped stateId ${stateId} → ${name}.`);
    return true;
  }

  // Conversational block remapping: "<source> is [actually] <target>"
  // e.g. "pumpkin_stem is stone_bricks" or "see tall_grass is actually passable"
  {
    const m = lower.match(IS_BLOCK_ALIAS);
    if (m) {
      const [, source, target] = m;
      // Ignore obvious non-block phrases
      const IGNORE = new Set(['this', 'that', 'it', 'nilo', 'he', 'she', 'a', 'the', 'here', 'there']);
      if (!IGNORE.has(source) && !IGNORE.has(target)) {
        const ids = getStateIdsByName(bot, source);
        if (ids.length) {
          for (const id of ids) setManualOverride(bot, id, target);
          bot.chat(`Got it — ${source} (${ids.length} state ID${ids.length > 1 ? 's' : ''}) → ${target}.`);
          return true;
        }
      }
    }
  }

  return false;
}

module.exports = { handle };
