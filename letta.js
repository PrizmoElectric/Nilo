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

module.exports = { queryLetta, parseAction };
