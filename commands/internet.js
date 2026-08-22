// commands/internet.js — toggleable web-search access for Nilo, backed by
// the self-hosted SearXNG instance (see websearch.js).
//
// Exported separately from `handle` so discord-bridge.js's offline path
// (no Minecraft bot connected) can still toggle/search and reply via
// toDiscord — internet access doesn't depend on being logged into the game.
const { cmd } = require('./_util');
const state = require('../state');
const { MASTER } = require('../config');
const { searchWeb } = require('../websearch');

const IS_INTERNET_ON  = cmd([/\binternet\s+on\b/, /\benable\s+(?:the\s+)?(?:internet|web\s*search)\b/]);
const IS_INTERNET_OFF = cmd([/\binternet\s+off\b/, /\bdisable\s+(?:the\s+)?(?:internet|web\s*search)\b/]);
const SEARCH_RE = /^(?:search(?:\s+the\s+web)?(?:\s+for)?|google|web\s*search|look\s*up)\s+(.+)/i;

// Runs the search + Letta synthesis. Returns the reply text, or null if
// SearXNG had nothing. Throws on network/HTTP errors. Bot-independent.
async function runSearch(query) {
  const results = await searchWeb(query);
  if (!results) return null;

  const { sessionHintFor }    = require('../monitor');
  const { queryLetta, parseAction } = require('../letta');

  const ctx = `${sessionHintFor(MASTER)}${MASTER} asked you to search the web for "${query}". Here's what came back:\n${results}\n\nAnswer in your own voice, 1-3 sentences. Don't read out the list or mention "search results".`;
  const raw = await queryLetta(ctx);
  return parseAction(raw);
}

async function handle(bot, lower, raw) {
  if (IS_INTERNET_ON(lower)) {
    state.internetEnabled = true;
    bot.chat("Internet on — I'll search the web on my own when it's useful.");
    return true;
  }

  if (IS_INTERNET_OFF(lower)) {
    state.internetEnabled = false;
    bot.chat('Internet off.');
    return true;
  }

  const m = raw.match(SEARCH_RE);
  if (m) {
    if (!state.internetEnabled) {
      bot.chat('Internet access is off — say "internet on" first.');
      return true;
    }

    const query = m[1].trim();
    if (!query) return false;

    bot.chat(`Searching: ${query}...`);
    try {
      const result = await runSearch(query);
      if (!result) { bot.chat("Nothing useful came back."); return true; }

      const { chatLong }       = require('../letta');
      const { dispatchAction } = require('../actions');
      const { text, action }   = result;
      if (text)   await chatLong(bot, text);
      if (action) dispatchAction(bot, action, MASTER);
    } catch (err) {
      console.error('[INTERNET] search error:', err.message);
      bot.chat("Couldn't reach the search engine.");
    }
    return true;
  }

  return false;
}

module.exports = { handle, IS_INTERNET_ON, IS_INTERNET_OFF, SEARCH_RE, runSearch };
