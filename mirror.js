// mirror.js — record and replay player actions
// watch mode: Nilo stays put, looks at master, logs events only
// learn mode: Nilo follows master, replays actions, records to mirrors/

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const Vec3   = require('vec3');
const { clearBehavior } = require('./behavior');
const { MASTER } = require('./config');

const CONTEXT_MOD_HOST = 'localhost';
const CONTEXT_MOD_PORT = 8080;
const MIRRORS_DIR      = path.join(__dirname, 'mirrors');
const POLL_MS          = 50;

let mirrorMode     = null;   // 'watch' | 'learn' | null
let pollInterval   = null;
let lookInterval   = null;
let followInterval = null;
let recording      = null;   // { filePath, startTime, events[], meta{} }

// ── HTTP poll ─────────────────────────────────────────────────────────────────

function pollEvents() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: CONTEXT_MOD_HOST, port: CONTEXT_MOD_PORT, path: '/mirror-events', timeout: 200 },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ── Watch mode ────────────────────────────────────────────────────────────────

function startWatch(bot) {
  _stop(bot);
  mirrorMode = 'watch';

  // Look at master every 100ms
  lookInterval = setInterval(() => {
    const master = bot.players[MASTER]?.entity;
    if (master) bot.lookAt(master.position.offset(0, master.height, 0), true);
  }, 100);

  // Poll and log only — no replay, no recording
  pollInterval = setInterval(async () => {
    const events = await pollEvents();
    for (const ev of events) {
      console.log('[MIRROR watch]', JSON.stringify(ev));
    }
  }, POLL_MS);

  bot.chat('Watching you.');
}

// ── Learn / mirror mode ───────────────────────────────────────────────────────

function startLearn(bot) {
  _stop(bot);
  mirrorMode = 'learn';

  if (!fs.existsSync(MIRRORS_DIR)) fs.mkdirSync(MIRRORS_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(MIRRORS_DIR, `mirror_${ts}.json`);
  recording = { filePath, startTime: Date.now(), events: [], meta: { recorded: new Date().toISOString() } };

  // Follow master with pathfinder (1s refresh)
  const { GoalFollow } = require('./pathfinder-compat').goals;
  followInterval = setInterval(() => {
    const master = bot.players[MASTER]?.entity;
    if (master) bot.pathfinder.setGoal(new GoalFollow(master, 2), true);
  }, 1000);

  // Poll, replay and record
  pollInterval = setInterval(async () => {
    const events = await pollEvents();
    for (const ev of events) {
      const t = Date.now() - recording.startTime;
      recording.events.push({ t, ...ev });
      _replayEvent(bot, ev);
    }
  }, POLL_MS);

  bot.chat(`Mirroring you. Recording to ${path.basename(filePath)}.`);
}

// ── Stop ──────────────────────────────────────────────────────────────────────

function stopMirror(bot) {
  const wasRecording = !!recording;
  _stop(bot);
  if (wasRecording) {
    bot.chat('Stopped mirroring.');
  } else {
    bot.chat('Not mirroring.');
  }
}

function _stop(bot) {
  if (pollInterval)   { clearInterval(pollInterval);   pollInterval   = null; }
  if (lookInterval)   { clearInterval(lookInterval);   lookInterval   = null; }
  if (followInterval) { clearInterval(followInterval); followInterval = null; }
  if (bot) clearBehavior(bot);

  if (recording) {
    const out = JSON.stringify(
      { recorded: recording.meta.recorded, events: recording.events },
      null, 2
    );
    try { fs.writeFileSync(recording.filePath, out); } catch (e) { /* ignore */ }
    console.log(`[MIRROR] Saved ${recording.events.length} events → ${path.basename(recording.filePath)}`);
    recording = null;
  }

  mirrorMode = null;
}

// ── Event replay ──────────────────────────────────────────────────────────────

function _replayEvent(bot, ev) {
  try {
    switch (ev.type) {
      case 'move':
      case 'look':
        // Mirror orientation; pathfinder handles position tracking
        bot.look(ev.yaw, ev.pitch, true);
        break;

      case 'dig': {
        const block = bot.blockAt(new Vec3(ev.x, ev.y, ev.z));
        if (block && block.name !== 'air') {
          bot.pathfinder.setGoal(null);
          bot.dig(block, true).catch(() => {});
        }
        break;
      }

      case 'use_block': {
        const block = bot.blockAt(new Vec3(ev.x, ev.y, ev.z));
        if (block) bot.activateBlock(block).catch(() => {});
        break;
      }

      case 'use_item':
        bot.activateItem();
        break;

      case 'use_entity': {
        const entity = ev.entityId != null
          ? Object.values(bot.entities).find(e => e.id === ev.entityId)
          : null;
        if (entity) bot.activateEntity(entity).catch(() => {});
        break;
      }

      case 'custom_packet':
        // Cannot replay custom mod packets yet — recorded for future analysis
        break;
    }
  } catch {
    // Ignore individual replay errors
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

function getMirrorStatus() {
  if (!mirrorMode) return null;
  const info = { mode: mirrorMode };
  if (recording) {
    info.events   = recording.events.length;
    info.duration = Math.round((Date.now() - recording.startTime) / 1000);
    info.file     = path.basename(recording.filePath);
  }
  return info;
}

// Called on bot disconnect — saves recording without touching bot state
function saveMirrorRecording() {
  if (pollInterval)   { clearInterval(pollInterval);   pollInterval   = null; }
  if (lookInterval)   { clearInterval(lookInterval);   lookInterval   = null; }
  if (followInterval) { clearInterval(followInterval); followInterval = null; }
  mirrorMode = null;

  if (!recording) return;
  const out = JSON.stringify(
    { recorded: recording.meta.recorded, events: recording.events },
    null, 2
  );
  try {
    fs.writeFileSync(recording.filePath, out);
    console.log(`[MIRROR] Saved on disconnect: ${path.basename(recording.filePath)} (${recording.events.length} events)`);
  } catch (e) {
    console.error('[MIRROR] Failed to save on disconnect:', e.message);
  }
  recording = null;
}

module.exports = { startWatch, startLearn, stopMirror, getMirrorStatus, saveMirrorRecording };
