#!/usr/bin/env node
// Generates a custom prismarine-viewer atlas and blockStates JSON for Prominence.
// Run once after server restart: node build-viewer-assets.js
// Outputs: nilo-assets/prominence-atlas.png, nilo-assets/prominence-blockstates.json

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { createCanvas, loadImage } = require('canvas');

const ATLAS_SIZE    = 4096;
const TILE_SIZE     = 16;
const TILES_PER_ROW = ATLAS_SIZE / TILE_SIZE;    // 256
const UV_SCALE      = 512 / ATLAS_SIZE;           // 0.125 (vanilla was 512px wide)
const VANILLA_ROWS  = 512 / TILE_SIZE;            // 32 — vanilla tiles in rows 0-31
const MODDED_ROW0   = VANILLA_ROWS;               // modded tiles start at row 32

const VANILLA_BLOCKSTATES = path.join(
  __dirname, '..', 'node_modules/prismarine-viewer/public/blocksStates/1.20.1.json');
const VANILLA_ATLAS = path.join(
  __dirname, '..', 'node_modules/prismarine-viewer/public/textures/1.20.1.png');
const OUT_DIR = path.join(__dirname, '..', 'nilo-assets');

// ── helpers ────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// djb2 hash → HSL color, returns [r, g, b]
function hashToColor(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  h = Math.abs(h);
  const hue = h % 360;
  const sat = 55 + (h >> 8) % 30;   // 55–84 %
  const lit = 40 + (h >> 16) % 25;  // 40–64 %
  return hslToRgb(hue / 360, sat / 100, lit / 100);
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1/3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1/3)]
    .map(x => Math.round(x * 255));
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

// Recursively scale all {u,v,su,sv,bu,bv} coordinate sets in a blockStates entry.
function scaleUVs(obj, scale) {
  if (Array.isArray(obj)) return obj.map(x => scaleUVs(x, scale));
  if (obj && typeof obj === 'object') {
    // Detect a UV object: has u and su (or just u)
    if ('u' in obj && 'su' in obj) {
      const out = { ...obj };
      out.u  = obj.u  * scale;
      out.v  = obj.v  * scale;
      out.su = obj.su * scale;
      out.sv = obj.sv * scale;
      if ('bu' in obj) out.bu = obj.bu * scale;
      if ('bv' in obj) out.bv = obj.bv * scale;
      return out;
    }
    const out = {};
    for (const k of Object.keys(obj)) out[k] = scaleUVs(obj[k], scale);
    return out;
  }
  return obj;
}

// Build a simple solid full-cube blockStates entry.
function solidCubeEntry(u, v, su) {
  const tex = { u, v, su, sv: su };
  const face = dir => ({ texture: { ...tex }, cullface: dir });
  return {
    variants: {
      '': [{
        model: {
          textures: {
            particle: { ...tex }, all: { ...tex },
            up: { ...tex }, down: { ...tex },
            north: { ...tex }, south: { ...tex },
            east: { ...tex }, west: { ...tex },
          },
          elements: [{
            from: [0, 0, 0],
            to:   [16, 16, 16],
            faces: {
              up:    face('up'),
              down:  face('down'),
              north: face('north'),
              south: face('south'),
              east:  face('east'),
              west:  face('west'),
            },
            ao: true,
          }],
          ao: true,
        },
      }],
    },
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching /all-blocks from context mod…');
  let allBlocks;
  try {
    allBlocks = await fetchJSON('http://localhost:8080/all-blocks');
  } catch (e) {
    console.error('ERROR: Could not reach http://localhost:8080/all-blocks —', e.message);
    console.error('Is the context mod running? (server must be online)');
    process.exit(1);
  }

  const uniqueModded = [...new Set(
    Object.values(allBlocks).filter(n => !n.startsWith('minecraft:'))
  )].sort();
  console.log(`Got ${Object.keys(allBlocks).length} stateIds, ${uniqueModded.length} unique modded names.`);

  // Capacity check
  const maxModdedSlots = (TILES_PER_ROW - MODDED_ROW0) * TILES_PER_ROW;
  if (uniqueModded.length > maxModdedSlots) {
    console.error(`ERROR: need ${uniqueModded.length} tiles but only ${maxModdedSlots} modded slots available.`);
    process.exit(1);
  }

  console.log('Loading vanilla data…');
  const vanillaBS = JSON.parse(fs.readFileSync(VANILLA_BLOCKSTATES));
  const vanillaImg = await loadImage(VANILLA_ATLAS);

  console.log(`Building ${ATLAS_SIZE}×${ATLAS_SIZE} atlas…`);
  const canvas = createCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const ctx = canvas.getContext('2d');

  // Copy vanilla tiles (top-left 512×512 → same pixel positions in new atlas)
  ctx.drawImage(vanillaImg, 0, 0, 512, 512, 0, 0, 512, 512);

  // Draw modded tiles
  const moddedUV = {};
  for (let i = 0; i < uniqueModded.length; i++) {
    const name = uniqueModded[i];
    const col  = i % TILES_PER_ROW;
    const row  = MODDED_ROW0 + Math.floor(i / TILES_PER_ROW);
    const px   = col * TILE_SIZE;
    const py   = row * TILE_SIZE;
    const [r, g, b] = hashToColor(name);

    // 1px dark border, colored interior
    ctx.fillStyle = `rgb(${Math.round(r*0.4)},${Math.round(g*0.4)},${Math.round(b*0.4)})`;
    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(px + 1, py + 1, TILE_SIZE - 2, TILE_SIZE - 2);

    moddedUV[name] = {
      u:  col / TILES_PER_ROW,
      v:  row / TILES_PER_ROW,
      su: 1   / TILES_PER_ROW,
    };
  }

  console.log('Generating blockStates JSON…');
  const out = {};

  // Vanilla: rescale all UV coords by UV_SCALE (1/8)
  for (const [name, data] of Object.entries(vanillaBS)) {
    out[name] = scaleUVs(data, UV_SCALE);
  }

  // Modded: simple solid cube per unique name
  for (const name of uniqueModded) {
    const { u, v, su } = moddedUV[name];
    out[name] = solidCubeEntry(u, v, su);
  }

  // Registry array: index = stateId, value = blockName for the browser to use.
  // Vanilla blocks: strip "minecraft:" so names match blockStates JSON keys.
  // Modded blocks: keep full "mod:name" as-is.
  console.log('Building registry array…');
  let maxSid = 0;
  for (const k of Object.keys(allBlocks)) { const n = parseInt(k); if (n > maxSid) maxSid = n; }
  const registry = new Array(maxSid + 1).fill('');
  for (const [sid, name] of Object.entries(allBlocks)) {
    registry[parseInt(sid)] = name.startsWith('minecraft:') ? name.slice(10) : name;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const regPath = path.join(OUT_DIR, 'prominence-registry.json');
  fs.writeFileSync(regPath, JSON.stringify(registry));
  console.log(`Wrote ${regPath} (${registry.length} entries, ${(fs.statSync(regPath).size / 1024).toFixed(0)} KB)`);

  const jsonPath = path.join(OUT_DIR, 'prominence-blockstates.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out));
  console.log(`Wrote ${jsonPath} (${Object.keys(out).length} entries)`);

  const pngPath = path.join(OUT_DIR, 'prominence-atlas.png');
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, buf);
  console.log(`Wrote ${pngPath} (${(buf.length / 1024).toFixed(0)} KB)`);

  // Deploy to prismarine-viewer's static directory.
  // Back up vanilla originals once so they can be restored if needed.
  const PUBLIC = path.join(__dirname, '..', 'node_modules/prismarine-viewer/public');
  const destJson = path.join(PUBLIC, 'blocksStates/1.20.1.json');
  const destPng  = path.join(PUBLIC, 'textures/1.20.1.png');
  if (!fs.existsSync(destJson + '.vanilla')) {
    fs.copyFileSync(destJson, destJson + '.vanilla');
    console.log('Backed up vanilla blockstates → 1.20.1.json.vanilla');
  }
  if (!fs.existsSync(destPng + '.vanilla')) {
    fs.copyFileSync(destPng, destPng + '.vanilla');
    console.log('Backed up vanilla atlas → 1.20.1.png.vanilla');
  }
  fs.copyFileSync(jsonPath, destJson);
  fs.copyFileSync(pngPath, destPng);
  fs.copyFileSync(regPath, path.join(PUBLIC, 'prominence-registry.json'));
  console.log('Deployed to prismarine-viewer public directory.');
  console.log('Refresh your browser (hard refresh if cached). No Nilo restart needed.');
}

main().catch(e => { console.error(e); process.exit(1); });
