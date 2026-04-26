const { craftItem, smeltItem, ensureTools, listCraftable } = require('../skills/crafting');
const { cmd } = require('./_util');

const IS_WHAT_CAN_CRAFT = cmd([
  /\bwhat can (i |you |we )?craft\b/, /\bwhat can (i |you |we )?make\b/,
  /\blist (what|all) (i |you )?can (craft|make)\b/,
  /\bshow (me |your )?(craftable|recipes)\b/,
  /\bo que (você |eu |a gente )?pode (craftar|fazer|construir)\b/,
]);
const IS_ENSURE_TOOLS = cmd([
  /\b(craft|make) (me |some )?(basic |missing )?tools?\b/,
  /\bensure tools?\b/, /\bcheck tools?\b/, /\bdo (i|you) have tools?\b/,
  /\b(faz|crafta) (as |umas )?ferramentas?\b/,
]);
const IS_SMELT = cmd([
  /\bsmelt\b/, /\bfurnace\b/, /\bcook (the |some |my )?\w/,
  /\bburn (the |some |my )?\w/,
  /\bfundir?\b/, /\bderretar?\b/, /\bcozinhar?\b/, /\bforja\b/,
]);
const IS_CRAFT = cmd([
  /\bcraft\b/, /\bmake\b/, /\bbuild (a |an |some )?\w/,
  /\bcreate (a |an |some )?\w/, /\bfabricar?\b/, /\bconstruir?\b/, /\bcraftar?\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_WHAT_CAN_CRAFT(lower)) {
    bot.chat(listCraftable(bot));
    return true;
  }

  if (IS_ENSURE_TOOLS(lower)) {
    ensureTools(bot).catch(err => console.error('[CRAFT] ensureTools error:', err.message));
    return true;
  }

  if (IS_SMELT(lower)) {
    const m = raw.match(/(?:smelt|cook|burn|fundir|cozinhar?|derretar?)\s+(?:the |some |my |(\d+)\s+)?([a-z][a-z0-9_ ]*)/i);
    if (m) {
      const count    = m[1] ? parseInt(m[1]) : 1;
      const itemName = m[2].trim();
      smeltItem(bot, itemName, count).catch(err => console.error('[SMELT] error:', err.message));
      return true;
    }
    bot.chat("What should I smelt?");
    return true;
  }

  if (IS_CRAFT(lower)) {
    const m = raw.match(/(?:craft|make|build|create|fabricar?|construir?|craftar?)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+|(\d+)\s+)?([a-z][a-z0-9_ ]*)/i);
    if (m) {
      const count    = m[1] ? parseInt(m[1]) : 1;
      const itemName = m[2].trim();
      craftItem(bot, itemName, count).catch(err => console.error('[CRAFT] error:', err.message));
      return true;
    }
    bot.chat("What should I craft?");
    return true;
  }

  return false;
}

module.exports = { handle };
