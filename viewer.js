// viewer.js — browser views for Nilo
// prismarine-viewer (desktop): 3D world view     → http://localhost:3007
// prismarine-viewer (mobile) : 3D world view     → http://localhost:3006  (2048 atlas)
// mineflayer-web-inventory   : inventory         → http://localhost:3000
//
// Called on every spawn. World viewers are closed and restarted with the new bot
// each time (prismarine-viewer binds to a specific bot instance and has no
// reconnect support). Inventory viewer auto-stops on bot.end so just restart it.

const WORLD_PORT     = parseInt(process.env.VIEWER_PORT        || '3007', 10);
const MOBILE_PORT    = parseInt(process.env.VIEWER_MOBILE_PORT || '3006', 10);
const INVENTORY_PORT = parseInt(process.env.INVENTORY_PORT     || '3000', 10);

let closeWorldViewer = null; // stored close fn from previous spawn

async function installViewers(bot) {
  // ── 3D world viewers ──────────────────────────────────────────────────────
  // Close previous instances first to free the ports, then start fresh.
  if (closeWorldViewer) {
    try { closeWorldViewer(); } catch (_) {}
    closeWorldViewer = null;
    await new Promise(r => setTimeout(r, 300)); // let ports release
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

    // Desktop viewer — full 4096×4096 atlas
    prismarineViewer(bot, { port: WORLD_PORT,  firstPerson: false, customRegistryProvider: registryProvider });
    const closeDesktop = bot.viewer.close.bind(bot.viewer);
    console.log(`[VIEWER] 3D world view (desktop) → http://localhost:${WORLD_PORT}`);

    // Mobile viewer — 2048×2048 atlas (browser selects via port 3006 detection)
    prismarineViewer(bot, { port: MOBILE_PORT, firstPerson: false, customRegistryProvider: registryProvider });
    const closeMobile = bot.viewer.close.bind(bot.viewer);
    console.log(`[VIEWER] 3D world view (mobile)  → http://localhost:${MOBILE_PORT}`);

    closeWorldViewer = () => { try { closeDesktop(); } catch (_) {} try { closeMobile(); } catch (_) {} };
  } catch (err) {
    console.error('[VIEWER] World viewer failed:', err.message);
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
