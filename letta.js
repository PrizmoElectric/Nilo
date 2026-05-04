// letta.js — Letta API client and response parsing

const { LETTA_URL } = require('./config');

// ── Letta API ─────────────────────────────────────────────────────────────────

async function queryLetta(userMessage) {
  const { default: fetch } = await import('node-fetch');

  const res = await fetch(LETTA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  for (const msg of data.messages || []) {
    if (msg.message_type === 'assistant_message' && msg.content) {
      // Strip emojis and trim
      return msg.content.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
    }
  }

  throw new Error('No assistant_message response from Letta');
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
