// viewer.js — browser views for Nilo
// prismarine-viewer (desktop): 3D world view     → http://localhost:3007
// mobile-stream               : screenshot stream → http://localhost:3006
//   Puppeteer renders 3007 headlessly, streams JPEG frames via WebSocket.
//   Phone just displays an image — zero WebGL on device.
// mineflayer-web-inventory   : inventory         → http://localhost:3000
//
// Called on every spawn. World viewer is closed and restarted with the new bot
// each time (prismarine-viewer binds to a specific bot instance and has no
// reconnect support). The stream server starts once and keeps running.

const WORLD_PORT     = parseInt(process.env.VIEWER_PORT        || '3007', 10);
const MOBILE_PORT    = parseInt(process.env.VIEWER_MOBILE_PORT || '3006', 10);
const INVENTORY_PORT = parseInt(process.env.INVENTORY_PORT     || '3000', 10);

let closeWorldViewer = null;
let streamStarted    = false;

async function installViewers(bot) {
  // ── Desktop 3D world viewer ───────────────────────────────────────────────
  if (closeWorldViewer) {
    try { closeWorldViewer(); } catch (_) {}
    closeWorldViewer = null;
    await new Promise(r => setTimeout(r, 300));
  }

  try {
    const { mineflayer: prismarineViewer } = require('prismarine-viewer');
    const { getResolved } = require('./registry-patch');
    prismarineViewer(bot, {
      port: WORLD_PORT,
      firstPerson: false,
      customRegistryProvider: () => {
        const resolved = getResolved();
        const out = {};
        for (const [id, info] of Object.entries(resolved)) out[id] = info.name;
        return out;
      },
    });
    closeWorldViewer = () => bot.viewer?.close();
    console.log(`[VIEWER] 3D world view (desktop) → http://localhost:${WORLD_PORT}`);
  } catch (err) {
    console.error('[VIEWER] World viewer failed:', err.message);
  }

  // ── Mobile screenshot stream (starts once, keeps running across respawns) ─
  if (!streamStarted) {
    streamStarted = true;
    const { startStream } = require('./mobile-stream');
    // Give the desktop viewer a moment to finish binding before puppeteer opens it
    setTimeout(() => {
      startStream(MOBILE_PORT).catch(err =>
        console.error('[STREAM] Failed to start:', err.message)
      );
    }, 3000);
  }

  // ── Inventory viewer ──────────────────────────────────────────────────────
  // mineflayer-web-inventory auto-stops on bot.end, so port 3000 is free.
  try {
    const inventoryViewer = require('mineflayer-web-inventory');
    await inventoryViewer(bot, { port: INVENTORY_PORT });
    console.log(`[VIEWER] Inventory view  → http://localhost:${INVENTORY_PORT}`);
  } catch (err) {
    console.error('[VIEWER] Inventory viewer failed:', err.message);
  }
}

module.exports = { installViewers };
