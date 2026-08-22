// persist.js — save and restore bot behavior across reboots
const fs   = require('fs');
const path = require('path');
const state = require('./state');

const PERSIST_PATH = path.join(__dirname, 'persist.json');

// Only these modes are worth restoring — activity/combat modes don't survive a reboot.
const RESTORABLE = new Set(['idle', 'sit', 'follow', 'wander', 'defensive', 'passive']);

function saveBehavior(mode, owner) {
  if (!RESTORABLE.has(mode)) return;
  try {
    fs.writeFileSync(PERSIST_PATH, JSON.stringify({
      mode,
      owner: owner || null,
      exploringEnabled: state.exploringEnabled,
    }));
  } catch (e) {
    console.error('[PERSIST] save failed:', e.message);
  }
}

function loadBehavior() {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
    if (!data?.mode || !RESTORABLE.has(data.mode)) return null;
    return data;
  } catch (e) {
    console.error('[PERSIST] load failed:', e.message);
    return null;
  }
}

module.exports = { saveBehavior, loadBehavior };
