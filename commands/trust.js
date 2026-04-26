const { cmd } = require('./_util');

const IS_LIST_TRUSTED = cmd([
  /\bwho do you trust\b/, /\blist (?:the )?trusted\b/, /\bshow (?:the )?trusted\b/,
  /\bquem você confia\b/, /\blista (?:de )?confiados?\b/,
]);
const IS_UNTRUST = cmd([
  /\buntrust\b/, /\bdistrust\b/, /\bstop trusting\b/, /\bremove .+ from (?:the )?trusted\b/,
  /\bdon'?t trust\b/, /\bno longer trust\b/,
  /\bpara de confiar\b/, /\btira .+ dos? confiados?\b/, /\bnão confia? em\b/,
]);
const IS_TRUST = cmd([
  /\btrust\b/,
  /\badd .+ to (?:the )?trusted\b/,
  /\blet .+ (?:give|issue|send) (?:you |nilo )?commands?\b/,
  /\bconfia em\b/, /\badiciona .+ aos? (?:confiados?|lista de confiança)\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_LIST_TRUSTED(lower)) {
    const { listTrusted } = require('../trust');
    const list = listTrusted().join(', ');
    bot.chat(list ? `I trust: ${list}` : "I don't trust anyone besides you.");
    return true;
  }

  if (IS_UNTRUST(lower)) {
    const { untrustPlayer } = require('../trust');
    const m = raw.match(/(?:untrust|distrust|stop trusting|remove|don'?t trust|no longer trust|para de confiar em|tira|não confia? em)\s+(\S+)/i);
    if (!m) { bot.chat("Who should I stop trusting?"); return true; }
    const name = m[1].replace(/[^a-zA-Z0-9_]/g, '');
    untrustPlayer(name);
    bot.chat(`Got it. I no longer trust ${name}.`);
    return true;
  }

  if (IS_TRUST(lower)) {
    const { trustPlayer } = require('../trust');
    const m = raw.match(/(?:trust|confia em|adiciona)\s+(\S+)/i);
    if (!m) { bot.chat("Who should I trust?"); return true; }
    const name = m[1].replace(/[^a-zA-Z0-9_]/g, '');
    if (!name) { bot.chat("Who should I trust?"); return true; }
    trustPlayer(name);
    bot.chat(`Okay, I now trust ${name}.`);
    return true;
  }

  return false;
}

module.exports = { handle };
