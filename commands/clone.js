// commands/clone.js — Clone Manifestation chat commands
//
// These commands control the FakePlayer manifestation (the flying copy of the
// player with their skin). Deliberately different phrasing from commands/clones.js
// which controls NILO's clone army.
//
//   "clone me" / "manifest me"       → summon one flying clone
//   "dismiss my clone" / "recall"    → remove it
//   "clone status"                   → report active + current target

const { cmd }    = require('./_util');
const { MASTER } = require('../config');
const cloneModule = require('../clone');

const IS_SUMMON_CLONE = cmd([
  /\bclone me\b/,
  /\bmanifest me\b/,
  /\bsummon (a |my )?clone\b/,
  /\bcreate (a |my )?clone\b/,
  /\breplicate me\b/,
]);
const IS_DISMISS_CLONE = cmd([
  /\bdismiss (my |the )?clone\b/,
  /\brecall (my |the )?clone\b/,
  /\bdispel (my |the )?clone\b/,
  /\bremove (my |the )?clone\b/,
  /\bcancel (my |the )?clone\b/,
]);
const IS_CLONE_STATUS = cmd([
  /\bclone (status|state|info|check)\b/,
  /\bmy clone\b.{0,20}\b(status|active|doing|target)\b/,
  /\bwhat is my clone\b/,
]);

async function handle(bot, lower, raw, username) {
  // Only handle clone-me / manifestation patterns — not "clones on" (NILO army)
  const hasKeyword = /\bclone me\b/.test(lower)
    || /\bmanifest me\b/.test(lower)
    || /\breplicate me\b/.test(lower)
    || (lower.includes('clone') && (lower.includes('summon') || lower.includes('create')
        || lower.includes('dismiss') || lower.includes('recall') || lower.includes('dispel')
        || lower.includes('status') || lower.includes('state') || lower.includes('my')));
  if (!hasKeyword) return false;
  if (username !== MASTER) return false;

  if (IS_CLONE_STATUS(lower)) {
    const state = await cloneModule.getState(username);
    if (!state) { bot.chat('Cannot reach Solsai.'); return true; }
    if (!state.active) { bot.chat('No clone active.'); return true; }
    const tgt = state.target ? `Targeting: ${state.target}.` : 'Idling.';
    bot.chat(`Clone active. ${tgt}`);
    return true;
  }

  if (IS_DISMISS_CLONE(lower)) {
    bot.chat(await cloneModule.dismiss(username));
    return true;
  }

  if (IS_SUMMON_CLONE(lower)) {
    bot.chat(await cloneModule.summon(username));
    return true;
  }

  return false;
}

module.exports = { handle };
