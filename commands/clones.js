// commands/clones.js — natural-language control of Nilo's clone army
const { cmd } = require('./_util');
const state = require('../state');
const { MASTER } = require('../config');
const { spawnClones, despawnAllClones, despawnClones, clones } = require('../clones');

const IS_CLONE_ON  = cmd([/\bcloneon\b/, /^clone\s+on$/]);
const IS_CLONE_OFF = cmd([/\bcloneoff\b/, /^clone\s+off$/]);
const IS_CLONE_N   = cmd([/\bclone\s+(\d{1,2})\b/]);
const IS_FREYR_ON  = cmd([/^freyr\s+on$/, /\bfreyrs?\s+on\b/]);
const IS_FREYR_OFF = cmd([/^freyr\s+off$/, /\bfreyrs?\s+off\b/]);

async function handle(bot, lower, raw, username) {
  if (username !== MASTER) return false;
  if (IS_CLONE_ON(lower)) {
    if (state.cloneModeActive) { bot.chat('Clone mode is already active.'); return true; }
    state.cloneModeActive = true;
    bot.chat('Clone mode active — say "clone 0" through "clone 20" to size my army (0 disbands).');
    return true;
  }

  if (IS_CLONE_OFF(lower)) {
    if (!state.cloneModeActive && clones.size === 0) {
      bot.chat('Clone mode is already off.');
      return true;
    }
    state.cloneModeActive = false;
    if (clones.size) bot.chat('Recalling Freyr Swords before disbanding...');
    const n = await despawnAllClones();
    bot.chat(n ? `Clone mode off — disbanded ${n} clone(s).` : 'Clone mode off.');
    return true;
  }

  const m = lower.match(/\bclone\s+(\d{1,2})\b/);
  if (m) {
    if (!state.cloneModeActive) {
      bot.chat('Clone mode is off — say "cloneon" first.');
      return true;
    }
    const count = Math.max(0, Math.min(20, parseInt(m[1], 10)));

    if (count < clones.size) {
      bot.chat('Reducing the army — recalling Freyr Swords before disbanding...');
      const removed = await despawnClones(count);
      bot.chat(count === 0
        ? `Disbanded ${removed} clone(s) — army stood down.`
        : `Disbanded ${removed} clone(s) — down to ${clones.size}.`);
      return true;
    }

    if (count === 0) { bot.chat('No clones out.'); return true; }

    const spawned = spawnClones(count);
    bot.chat(spawned.length
      ? `Spawning ${spawned.length} clone(s) — they'll join one by one.`
      : `Already have ${clones.size} clone(s) out.`);
    return true;
  }

  if (IS_FREYR_ON(lower)) {
    state.freyrCloneToggle = true;
    bot.chat('Freyr: on — clones will summon their swords.');
    return true;
  }
  if (IS_FREYR_OFF(lower)) {
    state.freyrCloneToggle = false;
    bot.chat('Freyr: off — clones will return their swords to inventory.');
    return true;
  }

  return false;
}

module.exports = { handle };
