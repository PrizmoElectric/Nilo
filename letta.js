// letta.js — Letta API client (with local Ollama fallback) and response parsing

const { LETTA_URL, OLLAMA_URL, OLLAMA_MODEL, NILO_FALLBACK_PERSONA } = require('./config');

const LETTA_TIMEOUT_MS = 30_000;

// ── Response cleanup ──────────────────────────────────────────────────────────
// Shared by both the Letta and Ollama paths. Strips emoji and filters out
// artifacts that occasionally leak into assistant text (memory-compaction
// dumps, internal narration, bare action words confused for a reply).

function cleanText(raw) {
  let text = raw.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
  // Strip a leading "A: " label — leftover habit from the old Q:/A: example format
  text = text.replace(/^A:\s*/i, '').trim();
  // Drop JSON blobs (memory compaction dumps, system_alert, etc.)
  if (/^\s*[{\[]/.test(text) && !/^\[ACTION:\s*\w+\]\s*$/i.test(text)) throw new Error('Model returned structured data, suppressing');
  // Drop raw tool-call blocks (e.g. <tool_call>{"name": "memory_insert", ...})
  if (/^\s*<tool_call>/i.test(text)) throw new Error('Model returned a tool call, suppressing');
  // Drop internal memory narration (first-person and third-person patterns)
  if (/^(got it[.,]|i('ve| have) (stored|saved|noted|updated|kept)|i'll keep this|memory (updated|saved)|noted[.,]|the (primary |main |current )?(goal|objective|task|priority)|the user('s| has| is)|scanning |no immediate threats|proceed with caution|high.level goal)/i.test(text)) throw new Error('Model returned memory narration, suppressing');
  // Drop responses that are only an action word (model confused action with reply)
  if (/^(follow|stay|sit|stop|come|closer|unstuck|dance|fish|wander|attack|guard|passive|explore|wave|spin|jump|sneak|stand|guard)\s*\.?\s*$/i.test(text)) throw new Error('Model returned bare action word, suppressing');
  return text;
}

// ── Letta API (potent model — Apollo's GPU-backed Qwen2.5-7B-Instruct-AWQ) ──────

async function fetchLettaRaw(userMessage) {
  const { default: fetch } = await import('node-fetch');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LETTA_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(LETTA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  for (const msg of data.messages || []) {
    if (msg.message_type === 'assistant_message' && msg.content) {
      return Array.isArray(msg.content)
        ? (msg.content.find(c => c.type === 'text')?.text ?? '')
        : String(msg.content);
    }
  }

  throw new Error('No assistant_message response from Letta');
}

// ── Ollama fallback (weaker local model, used when Letta is unreachable) ───────

async function fetchOllamaRaw(userMessage) {
  const { default: fetch } = await import('node-fetch');

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: NILO_FALLBACK_PERSONA },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data?.message?.content ?? '';
}

// ── Combined entry point ────────────────────────────────────────────────────────
// Tries the potent Letta model first; if it's unreachable (Apollo down, network
// blip, etc.) transparently falls back to a local Ollama model.

async function queryLetta(userMessage) {
  let raw;
  try {
    raw = await fetchLettaRaw(userMessage);
  } catch (err) {
    console.warn(`[LETTA] ${err.message} — falling back to local Ollama (${OLLAMA_MODEL})`);
    raw = await fetchOllamaRaw(userMessage);
  }
  return cleanText(raw);
}

// ── Action parsing ────────────────────────────────────────────────────────────

function parseAction(raw) {
  const m = raw.match(/\[ACTION:\s*(\w+)\]\s*$/i);
  if (!m) return { text: raw, action: null };
  return {
    text: raw.slice(0, m.index).trim(),
    action: m[1].toLowerCase(),
  };
}

// ── Multi-line chat sender ────────────────────────────────────────────────────
// Minecraft caps chat at 256 chars. Splits at word boundaries and sends each
// chunk with a short delay so the server doesn't drop messages.

const CHAT_MAX = 250;
const CHAT_DELAY_MS = 350;

async function chatLong(bot, text) {
  if (!text) return;
  if (text.length <= CHAT_MAX) { bot.chat(text); return; }

  const chunks = [];
  let remaining = text;
  while (remaining.length > CHAT_MAX) {
    let cut = remaining.lastIndexOf(' ', CHAT_MAX);
    if (cut <= 0) cut = CHAT_MAX;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, CHAT_DELAY_MS));
    bot.chat(chunks[i]);
  }
}

module.exports = { queryLetta, parseAction, chatLong };
