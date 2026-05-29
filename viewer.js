// viewer.js — browser views for Nilo
// prismarine-viewer (desktop): 3D world view      → http://localhost:3007  (third-person)
// prismarine-viewer (fp-only): first-person source → http://localhost:3009  (internal, for stream)
// mobile-stream               : screenshot stream  → http://localhost:3006
//   Puppeteer screenshots port 3009 (first-person) and streams to phone.
// mineflayer-web-inventory   : inventory           → http://localhost:3000
//
// Called on every spawn. World viewers are closed and restarted with the new bot.
// The stream server starts once and keeps running across respawns.

const WORLD_PORT     = parseInt(process.env.VIEWER_PORT        || '3007', 10);
const FP_PORT        = parseInt(process.env.VIEWER_FP_PORT     || '3009', 10); // internal
const MOBILE_PORT    = parseInt(process.env.VIEWER_MOBILE_PORT || '3006', 10);
const INVENTORY_PORT = parseInt(process.env.INVENTORY_PORT     || '3000', 10);

let closeWorldViewer = null;
let streamStarted    = false;

async function installViewers(bot) {
  // ── World viewers (desktop + first-person source) ─────────────────────────
  if (closeWorldViewer) {
    try { closeWorldViewer(); } catch (_) {}
    closeWorldViewer = null;
    await new Promise(r => setTimeout(r, 300));
  }

  try {
    const { mineflayer: prismarineViewer } = require('prismarine-viewer');
    const { getResolved } = require('./registry-patch');
    const registryProvider = () => {
      const resolved = getResolved();
      const out = {};
      for (const [id, info] of Object.entries(resolved)) out[id] = info.name;
      return out;
    };

    // Desktop — third-person orbit view
    prismarineViewer(bot, { port: WORLD_PORT, firstPerson: false, customRegistryProvider: registryProvider });
    const closeDesktop = bot.viewer.close.bind(bot.viewer);
    console.log(`[VIEWER] 3D world view (desktop) → http://localhost:${WORLD_PORT}`);

    // First-person source — screenshotted by Puppeteer for the mobile stream
    prismarineViewer(bot, { port: FP_PORT, firstPerson: true, viewDistance: 4, customRegistryProvider: registryProvider });
    const closeFP = bot.viewer.close.bind(bot.viewer);
    console.log(`[VIEWER] 3D world view (fp-src)  → http://localhost:${FP_PORT} (internal)`);

    closeWorldViewer = () => { try { closeDesktop(); } catch (_) {} try { closeFP(); } catch (_) {} };
  } catch (err) {
    console.error('[VIEWER] World viewer failed:', err.message);
  }

  // ── Mobile screenshot stream (starts once, keeps running across respawns) ─
  if (!streamStarted) {
    streamStarted = true;
    const { startStream } = require('./mobile-stream');
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
