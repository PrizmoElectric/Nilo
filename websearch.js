// websearch.js — gives Nilo read-only internet access via a self-hosted
// SearXNG metasearch instance (odysseus stack, JSON API enabled).
// Gated behind state.internetEnabled — see commands/internet.js.

const { SEARXNG_URL } = require('./config');
const state = require('./state');

const SEARCH_TIMEOUT_MS = 6000;
const SNIPPET_MAX = 160; // keep results small — Nilo's context window is tight

// Returns a short newline-separated summary of the top results for `query`,
// or null if SearXNG returned nothing usable. Throws on network/HTTP errors.
async function searchWeb(query, numResults = 3) {
  const { default: fetch } = await import('node-fetch');

  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);

  const data = await res.json();
  const results = (data.results || []).slice(0, numResults);
  if (!results.length) return null;

  return results.map((r, i) => {
    const snippet = (r.content || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
    return `${i + 1}. ${r.title} — ${snippet}`;
  }).join('\n');
}

// ── Autonomous search trigger ───────────────────────────────────────────────
// Letta's model is too context-starved (4096 tokens, mostly eaten by the
// system prompt + built-in tool schemas) to reliably decide on its own when
// to call a search tool — so that decision happens here in code instead.
// If a message looks like it needs live info, search proactively and hand
// the results to Letta as extra context for this turn.
const NEEDS_SEARCH_RE = new RegExp(
  '\\b(' + [
    'latest', 'newest', 'current(?:ly)?', 'recent(?:ly)?',
    'right now', 'nowadays', 'these days', 'up[- ]to[- ]date',
    'this (?:week|month|year)',
    'new(?:est)?\\s+(?:version|update|release|patch|snapshot)',
    "what'?s new", 'any (?:news|updates?)', 'news (?:about|on|for)',
    'price of', 'cost of', 'how much (?:is|does|are|do)',
    'exchange rate', 'stock price',
  ].join('|') + ')\\b',
  'i'
);

// Returns a context block to prepend to the Letta prompt (before the user's
// message), or null if no search was needed/possible. Never throws — a
// failed search just means no extra context, the conversation continues
// normally.
//
// Placement and framing matter a lot for a small model: results appended
// after the question, or framed as optional, get ignored in favor of the
// model's (often outdated/hallucinated) training data. Putting them first
// and explicitly telling the model to trust them over its own knowledge
// makes it actually use them.
async function getSearchContext(message) {
  if (!state.internetEnabled) return null;
  if (!NEEDS_SEARCH_RE.test(message)) return null;

  try {
    const results = await searchWeb(message);
    if (!results) return null;
    return `[CURRENT INFO as of today — your training data is outdated, trust this over what you think you know. Use naturally, don't mention "search" or list sources:\n${results}]`;
  } catch (err) {
    console.error('[WEBSEARCH] auto-search failed:', err.message);
    return null;
  }
}

module.exports = { searchWeb, getSearchContext };
