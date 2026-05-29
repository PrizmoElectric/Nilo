#!/usr/bin/env node
// Phase 2: bake real mod textures into the prismarine-viewer atlas.
// Requires the server online (for /all-blocks).
// Run: node build-mod-textures.js
// After completion, hard-refresh the browser viewer.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('canvas');

const MODS_DIR  = '/home/prizmo/mc-prominence2/data/mods';
const EXTRACT   = '/tmp/nilo-mod-assets';
const OUT_DIR   = path.join(__dirname, 'nilo-assets');
const PUBLIC    = path.join(__dirname, 'node_modules/prismarine-viewer/public');
const ATLAS_SZ  = 4096;
const TILE      = 16;
const TPR       = ATLAS_SZ / TILE;   // tiles per row = 256
const UV_SZ     = 1 / TPR;           // 0.00390625
const VANILLA_ROWS = 32;             // vanilla occupies atlas rows 0-31
const MOD_ROW0  = VANILLA_ROWS;      // modded textures start here

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

// Parse "modid:path/name" or "path/name" → canonical key "modid:path/name"
function rlKey(name) {
  if (!name || name.startsWith('#')) return null;
  if (name.includes(':')) return name;
  const p = name.replace(/^blocks\//, 'block/');
  return `minecraft:${p}`;
}

// djb2 hash → solid RGB colour (for fallback tiles)
function hashToColor(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  h = Math.abs(h);
  const hue = h % 360;
  const sat = 55 + (h >> 8) % 30;
  const lit = 40 + (h >> 16) % 25;
  return hslToRgb(hue / 360, sat / 100, lit / 100);
}
function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1/3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1/3)].map(x => Math.round(x * 255));
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

// ── Step 1: extract mod JARs ───────────────────────────────────────────────

function extractJars(neededMods) {
  fs.mkdirSync(EXTRACT, { recursive: true });
  const jars = fs.readdirSync(MODS_DIR).filter(f => f.endsWith('.jar'));
  console.log(`Scanning ${jars.length} JARs for ${neededMods.size} mods…`);
  let done = 0;
  for (const jar of jars) {
    const jp = path.join(MODS_DIR, jar);
    let listing;
    try { listing = execSync(`unzip -l "${jp}" 2>/dev/null`, { maxBuffer: 8e6 }).toString(); }
    catch { continue; }
    const hasNeeded = [...neededMods].some(m => listing.includes(`assets/${m}/blockstates/`));
    if (!hasNeeded) continue;
    try {
      // unzip exits non-zero if some glob patterns match nothing — ignore that
      execSync(
        `unzip -q -n "${jp}" ` +
        `"assets/*/blockstates/*.json" ` +
        `"assets/*/models/block/*.json" "assets/*/models/block/*/*.json" "assets/*/models/block/*/*/*.json" ` +
        `"assets/*/textures/block/*.png" "assets/*/textures/block/*/*.png" "assets/*/textures/block/*/*/*.png" "assets/*/textures/block/*/*/*/*.png" ` +
        `-d "${EXTRACT}" 2>/dev/null; exit 0`,
        { shell: '/bin/bash', maxBuffer: 100e6 }
      );
      done++;
    } catch {}
  }
  console.log(`Extracted assets from ${done} JARs → ${EXTRACT}`);
}

// ── Step 2: load model maps ────────────────────────────────────────────────

function loadAllModels(neededMods) {
  const models = {};

  // Vanilla models from minecraft-assets
  const mcAssets = require('./node_modules/minecraft-assets')('1.20.1');
  for (const [name, model] of Object.entries(mcAssets.blocksModels || {})) {
    models[`minecraft:block/${name}`] = model;
    models[name] = model; // bare name fallback
  }

  // Modded models from extracted JARs — walk subdirectories for mods like TechReborn
  function walkModels(dir, modid, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkModels(path.join(dir, entry.name), modid, prefix + entry.name + '/');
      } else if (entry.name.endsWith('.json')) {
        try {
          const rel = prefix + entry.name.slice(0, -5); // e.g. "ore/tin_ore"
          const key = `${modid}:block/${rel}`;
          models[key] = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
        } catch {}
      }
    }
  }
  for (const modid of neededMods) {
    walkModels(path.join(EXTRACT, 'assets', modid, 'models', 'block'), modid, '');
  }
  console.log(`Loaded ${Object.keys(models).length} models`);
  return models;
}

// ── Step 3: collect texture file paths ────────────────────────────────────

function loadTexturePaths(neededMods) {
  const paths = {};

  // Vanilla textures from minecraft-assets
  const mcAssets = require('./node_modules/minecraft-assets')('1.20.1');
  const vanDir = path.join(mcAssets.directory, 'blocks');
  if (fs.existsSync(vanDir)) {
    for (const file of fs.readdirSync(vanDir)) {
      if (!file.endsWith('.png')) continue;
      const name = file.slice(0, -4);
      const key = `minecraft:block/${name}`;
      paths[key] = path.join(vanDir, file);
      paths[name] = paths[key];
      paths[`blocks/${name}`] = paths[key];
    }
  }

  // Modded textures from extracted JARs — walk subdirectories
  function walkTextures(dir, modid, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkTextures(path.join(dir, entry.name), modid, prefix + entry.name + '/');
      } else if (entry.name.endsWith('.png')) {
        const rel = prefix + entry.name.slice(0, -4); // e.g. "ore/tin_ore"
        const key = `${modid}:block/${rel}`;
        paths[key] = path.join(dir, entry.name);
      }
    }
  }
  for (const modid of neededMods) {
    walkTextures(path.join(EXTRACT, 'assets', modid, 'textures', 'block'), modid, '');
  }
  console.log(`Found ${Object.keys(paths).length} texture paths`);
  return paths;
}

// ── Step 4: model resolution ───────────────────────────────────────────────

function resolveModelChain(resLoc, allModels, depth = 0) {
  if (depth > 20) return null;
  const key = rlKey(resLoc);
  const data = (key && allModels[key]) || allModels[resLoc];
  if (!data) return null;

  let model = { textures: {}, elements: [], ao: true };

  if (data.parent) {
    const parent = resolveModelChain(data.parent, allModels, depth + 1);
    if (parent) model = JSON.parse(JSON.stringify(parent));
  }
  if (data.textures) Object.assign(model.textures, data.textures);
  if (data.elements) model.elements = JSON.parse(JSON.stringify(data.elements));
  if (data.ambientocclusion !== undefined) model.ao = data.ambientocclusion;
  return model;
}

// Resolve all '#ref' chains in model.textures
function resolveTexRefs(textures) {
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const k of Object.keys(textures)) {
      const v = textures[k];
      if (v && v.startsWith('#')) {
        const resolved = textures[v.slice(1)];
        if (resolved && !resolved.startsWith('#')) {
          textures[k] = resolved;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

// ── Step 5: build atlas (real textures only; fallback tiles added later) ───

async function buildAtlas(allTexturePaths, existingVanillaAtlasPath) {
  const vanillaImg = await loadImage(
    fs.existsSync(existingVanillaAtlasPath + '.vanilla')
      ? existingVanillaAtlasPath + '.vanilla'
      : existingVanillaAtlasPath
  );

  const canvas = createCanvas(ATLAS_SZ, ATLAS_SZ);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(vanillaImg, 0, 0, 512, 512, 0, 0, 512, 512);

  const texSlots = {};
  let slotIdx = 0;

  // Only process genuinely modded texture keys (not vanilla or bare names)
  const texKeys = Object.keys(allTexturePaths)
    .filter(k => k.includes(':') && !k.startsWith('minecraft:'))
    .sort();

  console.log(`Drawing ${texKeys.length} modded textures into atlas…`);
  for (const key of texKeys) {
    const col = slotIdx % TPR;
    const row = MOD_ROW0 + Math.floor(slotIdx / TPR);
    if (row >= TPR) { console.warn('Atlas full!'); break; }
    const px = col * TILE, py = row * TILE;

    try {
      const img = await loadImage(allTexturePaths[key]);
      ctx.drawImage(img, 0, 0, 16, 16, px, py, TILE, TILE);
    } catch {
      const [r, g, b] = hashToColor(key);
      ctx.fillStyle = `rgb(${Math.round(r*0.4)},${Math.round(g*0.4)},${Math.round(b*0.4)})`;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px+1, py+1, TILE-2, TILE-2);
    }

    texSlots[key] = { u: col / TPR, v: row / TPR, su: UV_SZ, sv: UV_SZ };
    slotIdx++;
  }

  console.log(`Atlas: ${slotIdx} real texture slots used`);
  // Return ctx so caller can draw fallback tiles into the remaining slots
  return { canvas, ctx, texSlots, nextSlot: slotIdx };
}

// Draw a colored placeholder tile onto the canvas at a given slot index
function drawFallbackTile(ctx, slotIdx, blockName) {
  const col = slotIdx % TPR;
  const row = MOD_ROW0 + Math.floor(slotIdx / TPR);
  const px = col * TILE, py = row * TILE;
  const [r, g, b] = hashToColor(blockName);
  ctx.fillStyle = `rgb(${Math.round(r*0.4)},${Math.round(g*0.4)},${Math.round(b*0.4)})`;
  ctx.fillRect(px, py, TILE, TILE);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(px+1, py+1, TILE-2, TILE-2);
  return { u: col / TPR, v: row / TPR, su: UV_SZ, sv: UV_SZ };
}

// ── Step 6: bake a single blockStates entry ────────────────────────────────

function bakeEntry(blockstateDef, allModels, texSlots, blockName) {
  const out = {};

  const bakeVariant = (variantDef) => {
    const resLoc = variantDef.model;
    const model = resolveModelChain(resLoc, allModels);
    if (!model || !model.elements?.length) return null;

    // Resolve texture references
    const textures = { ...model.textures };
    resolveTexRefs(textures);

    // Look up each texture name in the atlas
    const resolvedTextures = {};
    for (const [k, v] of Object.entries(textures)) {
      if (!v || v.startsWith('#')) continue;
      const key = rlKey(v);
      const uv = (key && texSlots[key]) || texSlots[v];
      if (uv) resolvedTextures[k] = uv;
    }

    // Bake elements: replace face texture refs with atlas UVs + apply face UVs
    const bakedElements = [];
    for (const elem of model.elements) {
      const bakedFaces = {};
      for (const [sideName, face] of Object.entries(elem.faces || {})) {
        // Resolve this face's texture
        let texRef = face.texture;
        let depth = 0;
        while (texRef && texRef.startsWith('#') && depth++ < 10) {
          texRef = textures[texRef.slice(1)];
        }
        const key = rlKey(texRef);
        const tileUV = (key && texSlots[key]) || texSlots[texRef];
        if (!tileUV) continue;

        // Compute UV crop within the tile
        let uv = face.uv;
        if (!uv) {
          const f = elem.from, t = elem.to;
          uv = {
            north:  [t[0], 16-t[1], f[0], 16-f[1]],
            east:   [f[2], 16-t[1], t[2], 16-f[1]],
            south:  [f[0], 16-t[1], t[0], 16-f[1]],
            west:   [f[2], 16-t[1], t[2], 16-f[1]],
            up:     [f[0], f[2],    t[0], t[2]],
            down:   [t[0], f[2],    f[0], t[2]],
          }[sideName];
        }
        if (!uv) continue;

        const su = (uv[2] - uv[0]) * tileUV.su / 16;
        const sv = (uv[3] - uv[1]) * tileUV.sv / 16;
        const u  = tileUV.u + uv[0] * tileUV.su / 16;
        const v  = tileUV.v + uv[1] * tileUV.sv / 16;

        bakedFaces[sideName] = {
          texture: { u, v, su, sv },
          ...(face.cullface && { cullface: face.cullface }),
          ...(face.tintindex !== undefined && { tintindex: face.tintindex }),
          ...(face.rotation && { rotation: face.rotation }),
        };
      }
      if (Object.keys(bakedFaces).length === 0) continue;
      bakedElements.push({ from: elem.from, to: elem.to, faces: bakedFaces, ...(elem.rotation && { rotation: elem.rotation }) });
    }
    if (bakedElements.length === 0) return null;
    // Skip highly complex models (>2 elements) — keeps file size manageable.
    // Complex decoration blocks (Chipped etc.) fall back to colored cube.
    if (bakedElements.length > 2) return null;

    // Build model.textures (particle + face references) for the baked entry
    const modelTextures = {};
    for (const [k, v] of Object.entries(textures)) {
      if (resolvedTextures[k]) modelTextures[k] = resolvedTextures[k];
    }
    // Use first available texture as particle
    const firstTex = Object.values(resolvedTextures)[0] || null;
    if (firstTex) modelTextures.particle = firstTex;

    return {
      model: {
        textures: modelTextures,
        elements: bakedElements,
        ao: model.ao !== false,
      },
      ...(variantDef.x && { x: variantDef.x }),
      ...(variantDef.y && { y: variantDef.y }),
      ...(variantDef.uvlock && { uvlock: variantDef.uvlock }),
    };
  };

  if (blockstateDef.variants) {
    out.variants = {};
    for (const [propStr, variant] of Object.entries(blockstateDef.variants)) {
      const arr = Array.isArray(variant) ? variant : [variant];
      const baked = arr.map(bakeVariant).filter(Boolean);
      if (baked.length) out.variants[propStr] = baked;
    }
    if (!Object.keys(out.variants).length) return null;
  } else if (blockstateDef.multipart) {
    out.multipart = [];
    for (const part of blockstateDef.multipart) {
      const applies = Array.isArray(part.apply) ? part.apply : [part.apply];
      const baked = applies.map(bakeVariant).filter(Boolean);
      if (baked.length) {
        out.multipart.push({ when: part.when, apply: baked });
      }
    }
    if (!out.multipart.length) return null;
  }

  return out;
}

// ── Step 7: fallback solid-cube helpers ────────────────────────────────────

function solidCubeModel(u, v) {
  const tex = { u, v, su: UV_SZ, sv: UV_SZ };
  const face = dir => ({ texture: { ...tex }, cullface: dir });
  return {
    textures: { particle: tex, all: tex },
    elements: [{
      from: [0,0,0], to: [16,16,16],
      faces: { up: face('up'), down: face('down'), north: face('north'), south: face('south'), east: face('east'), west: face('west') },
      ao: true,
    }],
    ao: true,
  };
}

// Build a fallback entry that covers every variant key in the original blockstate def.
// Using "" alone only matches blocks with no state properties — doors, stairs etc.
// need exact keys like "facing=north,open=false" or they render invisible.
function solidCubeEntry(u, v, bsDef) {
  const model = solidCubeModel(u, v);
  const variantKeys = bsDef?.variants ? Object.keys(bsDef.variants) : [''];
  if (variantKeys.length === 0) variantKeys.push('');
  return { variants: Object.fromEntries(variantKeys.map(k => [k, [{ model }]])) };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('── Phase 2: real mod textures ──────────────────────────────');

  // Fetch all-blocks (or use cached copy if server is offline)
  const ALLBLOCKS_CACHE = path.join(OUT_DIR, 'all-blocks-cache.json');
  let allBlocks;
  try {
    console.log('Fetching /all-blocks…');
    allBlocks = await fetchJSON('http://localhost:8080/all-blocks');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(ALLBLOCKS_CACHE, JSON.stringify(allBlocks));
    console.log('Cached /all-blocks to disk.');
  } catch (e) {
    if (fs.existsSync(ALLBLOCKS_CACHE)) {
      console.log(`Server offline — using cached all-blocks (${ALLBLOCKS_CACHE})`);
      allBlocks = JSON.parse(fs.readFileSync(ALLBLOCKS_CACHE, 'utf8'));
    } else {
      // Reconstruct from the prominence-registry.json array
      const regPath = path.join(OUT_DIR, 'prominence-registry.json');
      if (fs.existsSync(regPath)) {
        console.log('Server offline — reconstructing from prominence-registry.json…');
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        allBlocks = {};
        reg.forEach((name, sid) => { if (name) allBlocks[sid] = name.includes(':') ? name : `minecraft:${name}`; });
      } else {
        console.error('No /all-blocks source available. Run with server online first.');
        process.exit(1);
      }
    }
  }

  const neededMods = new Set(
    Object.values(allBlocks)
      .filter(n => !n.startsWith('minecraft:'))
      .map(n => n.split(':')[0])
  );
  console.log(`${neededMods.size} mods need textures`);

  // Step 1: extract JAR assets
  extractJars(neededMods);

  // Step 2-3: load models + texture paths
  const allModels     = loadAllModels(neededMods);
  const allTexPaths   = loadTexturePaths(neededMods);

  // Step 4: build atlas — real modded textures first
  const atlasPath = path.join(PUBLIC, 'textures/1.20.1.png');
  const { canvas, ctx, texSlots, nextSlot } = await buildAtlas(allTexPaths, atlasPath);

  // Step 5: bake blockStates for modded blocks
  // Always start from the vanilla backup (11 MB) — never from our previous output
  // which can grow to hundreds of MB.  UVs in the vanilla file are in 512-atlas
  // space; scale by 1/8 to match our 4096×4096 atlas.
  const vanillaBS = path.join(PUBLIC, 'blocksStates/1.20.1.json.vanilla');
  const blockStates = JSON.parse(fs.readFileSync(vanillaBS, 'utf8'));
  (function scaleUVs(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.u === 'number') { obj.u *= 0.125; obj.v *= 0.125; obj.su *= 0.125; obj.sv *= 0.125; return; }
    for (const v of Object.values(obj)) scaleUVs(v);
  })(blockStates);

  const uniqueModded = [...new Set(
    Object.values(allBlocks).filter(n => !n.startsWith('minecraft:'))
  )].sort();

  console.log(`Baking ${uniqueModded.length} unique modded block entries…`);
  let bakedCount = 0, fallbackCount = 0;
  let fallbackSlotIdx = nextSlot; // colored fallback tiles go AFTER real textures

  for (const blockName of uniqueModded) {
    const [modid, localName] = blockName.split(':');
    const bsFile = path.join(EXTRACT, 'assets', modid, 'blockstates', `${localName}.json`);

    let entry = null;
    let bsDef = null;
    if (fs.existsSync(bsFile)) {
      try {
        bsDef = JSON.parse(fs.readFileSync(bsFile, 'utf8'));
        entry = bakeEntry(bsDef, allModels, texSlots, blockName);
      } catch {}
    }

    if (entry) {
      bakedCount++;
    } else {
      fallbackCount++;
      const fb = drawFallbackTile(ctx, fallbackSlotIdx, blockName);
      // Pass bsDef so every variant key (facing=north, open=false, …) maps to
      // the colored cube — without this, state-ful blocks render invisible.
      entry = solidCubeEntry(fb.u, fb.v, bsDef);
      fallbackSlotIdx++;
    }
    blockStates[blockName] = entry;
  }

  console.log(`Baked: ${bakedCount} with real textures, ${fallbackCount} fallback colored cubes`);

  // Step 6: save outputs
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Stream-write JSON to avoid V8 string length limit on large datasets
  const outJson = path.join(OUT_DIR, 'prominence-blockstates.json');
  const ws = fs.createWriteStream(outJson);
  ws.write('{');
  let firstEntry = true;
  for (const [key, val] of Object.entries(blockStates)) {
    if (!firstEntry) ws.write(',');
    ws.write(JSON.stringify(key) + ':' + JSON.stringify(val));
    firstEntry = false;
  }
  ws.write('}');
  await new Promise((res, rej) => { ws.end(); ws.on('finish', res); ws.on('error', rej); });
  console.log(`Wrote ${outJson} (${Object.keys(blockStates).length} entries)`);

  const outPng = path.join(OUT_DIR, 'prominence-atlas.png');
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(outPng, buf);
  console.log(`Wrote ${outPng} (${(buf.length / 1024).toFixed(0)} KB)`);

  // Deploy
  fs.copyFileSync(outJson, path.join(PUBLIC, 'blocksStates/1.20.1.json'));
  fs.copyFileSync(outPng,  path.join(PUBLIC, 'textures/1.20.1.png'));

  // Mobile atlas: 2048×2048 half-resolution (fits GPU memory on mid-range phones)
  const mobileCanvas = createCanvas(2048, 2048);
  const mobileCtx = mobileCanvas.getContext('2d');
  mobileCtx.imageSmoothingEnabled = false;
  mobileCtx.drawImage(canvas, 0, 0, ATLAS_SZ, ATLAS_SZ, 0, 0, 2048, 2048);
  const mobileBuf = mobileCanvas.toBuffer('image/png');
  const mobileOutPng = path.join(OUT_DIR, 'prominence-atlas-mobile.png');
  fs.writeFileSync(mobileOutPng, mobileBuf);
  console.log(`Wrote ${mobileOutPng} (${(mobileBuf.length / 1024).toFixed(0)} KB)`);
  fs.copyFileSync(mobileOutPng, path.join(PUBLIC, 'textures/1.20.1-mobile.png'));

  console.log('Deployed. Hard-refresh the viewer.');
}

main().catch(e => { console.error(e); process.exit(1); });
