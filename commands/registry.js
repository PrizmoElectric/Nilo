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

// Matches "<blockname> is [actually] <blockname>" for conversational remapping.
// Block names: lowercase letters/underscores, optional namespace (word:word).
const BLOCK_NAME = /[a-z][a-z_]*(?::[a-z][a-z_]*)*/;
const IS_BLOCK_ALIAS = new RegExp(
  `(${BLOCK_NAME.source})\\s+is\\s+(?:actually\\s+)?(${BLOCK_NAME.source})`
);

async function handle(bot, lower, raw) {
  if (IS_ECHO(lower) && /scan/.test(lower)) {
    if (!state.scans.length) { bot.chat('No scan yet.'); return true; }
    const numMatch = lower.match(/scan\s+(\d+)/);
    const idx = numMatch ? parseInt(numMatch[1]) : 0;
    if (idx >= state.scans.length) {
      bot.chat(`Only ${state.scans.length} scan(s) available (0–${state.scans.length - 1}).`);
      return true;
    }
    const { rows, radius, stamp } = state.scans[idx];
    const label = idx === 0 ? 'scan 0 (latest)' : `scan ${idx}`;
    bot.chat(`${label} r=${radius} @ ${stamp}:`);
    const lines = rows.slice(0, 20).map(([n, c]) => `${n}: ${c}`);
    let i = 0;
    const send = () => {
      if (i >= lines.length) return;
      bot.chat(lines.slice(i, i + 3).join(' | '));
      i += 3;
      setTimeout(send, 300);
    };
    send();
    return true;
  }

  if (IS_SCAN_BLOCKS(lower)) {
    runScan(bot, raw).catch(err => console.error('[SCAN] error:', err.message));
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
