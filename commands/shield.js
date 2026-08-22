// commands/shield.js — Shield Manifestation chat commands
//
// Nilo relays these to Solsai; the shield entities are ArmorStands
// managed by ShieldManifestManager on the server (no bot-body involvement).
//
//   "shield" / "summon shield"     → summon one more shield
//   "shield x3" / "3 shields"     → summon N shields in sequence
//   "dismiss shields" / "no shield" → remove all
//   "shield status"                → report count

const { cmd }    = require('./_util');
const { MASTER } = require('../config');
const shieldModule = require('../shield');

const IS_SHIELD_SUMMON = cmd([
  /\b(summon|manifest|add|raise|more|create)\b.{0,20}\bshield/,
  /\bshield\b.{0,20}\b(summon|manifest|add|on|up|more)\b/,
  /^shield$/,
]);
const IS_SHIELD_DOME = cmd([
  /\bdome\b/,
  /\bshield\b.{0,20}\b(dome|full|all)\b/,
  /\bmanifest\b.{0,20}\bdome\b/,
]);
const IS_SHIELD_SPLIT = cmd([
  /\b(split|divide|fracture|fragment|break)\b.{0,25}\bshield/,
  /\bshield\b.{0,25}\b(split|divide|fragment|fracture)\b/,
]);
const IS_SHIELD_DISMISS = cmd([
  /\b(dismiss|remove|stop|cancel|no|off|lower|clear)\b.{0,25}\bshield/,
  /\bshield\b.{0,25}\b(dismiss|remove|stop|off|down|cancel|clear|back|return)\b/,
]);
const IS_SHIELD_STATUS = cmd([
  /\bshield\b.{0,20}\b(status|count|how many|info|check|pool|durability)\b/,
  /\bhow many shields?\b/,
]);
const IS_FOCUS_DISTRIBUTED = cmd([
  /\bfocus\b.{0,25}\bshield/,
  /\bshield[s]?\b.{0,25}\bfocus\b/,
  /\bspread\b.{0,25}\bshield/,
  /^focus shields?$/,
]);
const IS_FOCUS_STACKED = cmd([
  /\bstack\b.{0,25}\bshield/,
  /\bshield[s]?\b.{0,25}\bstack(ed)?\b/,
  /\bconcentrate\b.{0,25}\bshield/,
  /^(stack|stacked) shields?$/,
]);
const IS_UNFOCUS = cmd([
  /\bunfocus\b.{0,25}\bshield/,
  /\bshield[s]?\b.{0,25}\b(unfocus|dome|scatter|spread out|disperse)\b/,
  /\b(reform|restore)\b.{0,25}\b(dome|shields?)\b/,
  /^unfocus shields?$/,
]);

function parseCount(lower, def = 1, max = 20) {
  let m = lower.match(/\b(\d+)\s*shield[s]?\b/)
       || lower.match(/\bshield[s]?\s*[x×]?\s*(\d+)\b/)
       || lower.match(/\b[x×]\s*(\d+)\b/);
  if (!m) return def;
  return Math.min(max, Math.max(2, parseInt(m[1], 10)));
}

async function handle(bot, lower, raw, username) {
  const hasKeyword = lower.includes('shield') || lower.includes('dome')
    || lower.includes('focus') || lower.includes('stack') || lower.includes('unfocus');
  if (!hasKeyword) return false;
  if (username !== MASTER) return false;

  if (IS_UNFOCUS(lower)) {
    bot.chat(await shieldModule.unfocus(username));
    return true;
  }

  if (IS_FOCUS_STACKED(lower)) {
    bot.chat(await shieldModule.focus(username, 'stacked', true));
    return true;
  }

  if (IS_FOCUS_DISTRIBUTED(lower)) {
    bot.chat(await shieldModule.focus(username, 'distributed', true));
    return true;
  }

  if (IS_SHIELD_DISMISS(lower)) {
    bot.chat(await shieldModule.dismissAll(username));
    return true;
  }

  if (IS_SHIELD_STATUS(lower)) {
    const state = await shieldModule.getState(username);
    if (!state) { bot.chat('Cannot reach Solsai.'); return true; }
    const n = state.count ?? 0;
    if (n === 0) { bot.chat('No shields active.'); return true; }
    const poolStr = state.split ? ` Shared pool: ${state.pool}.` : '';
    bot.chat(`${n} shield${n !== 1 ? 's' : ''} active.${poolStr}`);
    return true;
  }

  if (IS_SHIELD_SPLIT(lower)) {
    const n = parseCount(lower, 6, 20);
    bot.chat(await shieldModule.splitSummon(username, n));
    return true;
  }

  if (IS_SHIELD_DOME(lower)) {
    const n = parseCount(lower, 6, 20);
    bot.chat(await shieldModule.summonDome(username, n));
    return true;
  }

  if (IS_SHIELD_SUMMON(lower)) {
    const n = parseCount(lower, 1, 20);
    // Summon one-at-a-time for natural dome growth; only reply on the last
    for (let i = 0; i < n; i++) {
      const msg = await shieldModule.summon(username);
      if (i === n - 1) bot.chat(msg);
    }
    return true;
  }

  return false;
}

module.exports = { handle };
