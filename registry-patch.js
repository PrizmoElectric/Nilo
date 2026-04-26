// registry-patch.js — Fabric modded block registry auto-mapper
//
// Strategy:
//   1. Capture modded block names + block IDs from Fabric registry sync packet
//   2. As chunks load, scan their palettes for unknown state IDs (above vanilla max)
//   3. Gap analysis: consecutive runs of state IDs separated by gaps → infer block boundaries
//   4. Patch bot.registry so bot.blockAt() returns correct names automatically
//   5. modded-state-ids.json holds manual overrides with highest priority
//   6. Uncertain assignments are logged to modded-blocks-uncertain.log for review

const fs   = require('fs');
const path = require('path');

const OVERRIDE_FILE = path.join(__dirname, 'modded-state-ids.json');
const MAPPING_FILE  = path.join(__dirname, 'modded-blocks-mapping.json');
const UNCERTAIN_LOG = path.join(__dirname, 'modded-blocks-uncertain.log');

// ── State ─────────────────────────────────────────────────────────────────────

let moddedBlocks    = [];       // [{name, blockId}] sorted by blockId asc (registration order)
let discovered      = new Set(); // state IDs observed in chunk palettes
let resolved        = {};        // stateId → {name, confidence}
let manualOverrides = {};        // stateId → name (loaded from modded-state-ids.json)
let vanillaMax      = 0;

// ── Block physics overrides ───────────────────────────────────────────────────
// Applied after every patch. Prevents isSolidCommon heuristic from
// misclassifying known blocks. Add entries here as new problems are found.
const BLOCK_PHYSICS = {
  // Passable plants — bot walks THROUGH them, not on top
  grass:                 { boundingBox: 'empty', transparent: true,  shapes: [] },
  tall_grass:            { boundingBox: 'empty', transparent: true,  shapes: [] },
  fern:                  { boundingBox: 'empty', transparent: true,  shapes: [] },
  large_fern:            { boundingBox: 'empty', transparent: true,  shapes: [] },
  dead_bush:             { boundingBox: 'empty', transparent: true,  shapes: [] },
  vine:                  { boundingBox: 'empty', transparent: true,  shapes: [] },
  // Solid full blocks — heuristic misses these (no 'brick'/'stone'/'plank' in name)
  podzol:                { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  mycelium:              { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  coarse_dirt:           { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  rooted_dirt:           { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  mud:                   { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  // Server floor tiles — retextured by mod to be solid walkable floor
  pumpkin_stem:          { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  attached_pumpkin_stem: { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  melon_stem:            { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  attached_melon_stem:   { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
};

// ── File helpers ──────────────────────────────────────────────────────────────

function loadOverrides() {
  if (!fs.existsSync(OVERRIDE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) manualOverrides[parseInt(k)] = v;
    console.log(`[REGISTRY] Loaded ${Object.keys(manualOverrides).length} manual overrides`);
  } catch (e) {
    console.warn('[REGISTRY] Could not load modded-state-ids.json:', e.message);
  }
}

function saveManualOverrides() {
  try { fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(manualOverrides, null, 2), 'utf8'); } catch (_) {}
}

function saveMapping() {
  try { fs.writeFileSync(MAPPING_FILE, JSON.stringify(resolved, null, 2), 'utf8'); } catch (_) {}
}

function logUncertain(entries) {
  if (!entries.length) return;
  const ts = new Date().toISOString();
  const lines = entries.map(e =>
    `${ts} [${e.confidence.toUpperCase().padEnd(6)}] stateId=${String(e.stateId).padStart(6)}  name=${e.name}  reason: ${e.reason}`
  );
  try { fs.appendFileSync(UNCERTAIN_LOG, lines.join('\n') + '\n', 'utf8'); } catch (_) {}
}

// ── VarInt / String reader ────────────────────────────────────────────────────

function readVarInt(buf, offset) {
  let result = 0, shift = 0, byte;
  do {
    if (offset >= buf.length) throw new Error('VarInt read past end of buffer');
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  offset = len.offset;
  const str = buf.slice(offset, offset + len.value).toString('utf8');
  return { value: str, offset: offset + len.value };
}

// ── Fabric registry sync parser ───────────────────────────────────────────────

function parseFabricRegistrySync(buf) {
  const registries = {};
  let offset = 0;
  try {
    const peek = readVarInt(buf, 0);
    let count = peek.value;
    offset = peek.offset;
    if (count > 1000) {
      offset = 1;
      const retry = readVarInt(buf, offset);
      count = retry.value;
      offset = retry.offset;
    }
    for (let r = 0; r < count; r++) {
      const regName  = readString(buf, offset); offset = regName.offset;
      const entryCount = readVarInt(buf, offset); offset = entryCount.offset;
      const entries = {};
      for (let e = 0; e < entryCount.value; e++) {
        const name = readString(buf, offset); offset = name.offset;
        const id   = readVarInt(buf, offset);  offset = id.offset;
        entries[name.value] = id.value;
      }
      registries[regName.value] = entries;
    }
  } catch (err) {
    console.warn('[REGISTRY] Parse error (partial data may still work):', err.message);
  }
  return registries;
}

// ── Gap-analysis assignment ───────────────────────────────────────────────────
//
// Fabric assigns block IDs and state IDs in the same registration order.
// Unknown state IDs above vanillaMax therefore arrive in the same order as
// moddedBlocks (sorted by blockId). Gaps between consecutive state IDs seen
// in chunk palettes suggest a block type that hasn't appeared in loaded world
// yet — those gaps become segment boundaries.
//
// Confidence:
//   high   — segment count == modded block count (1:1 match)
//   medium — fewer segments than blocks (some blocks not yet seen)
//   low    — more segments than blocks (blocks have non-contiguous observed states,
//            or registration order assumption is off)

function resolveMapping(bot) {
  if (!moddedBlocks.length || !vanillaMax) return;

  const unknownIds = [...discovered]
    .filter(id => id > vanillaMax && !bot.registry.blocksByStateId[id])
    .sort((a, b) => a - b);

  if (!unknownIds.length) return;

  // Split into consecutive runs — gaps are potential block boundaries
  const segments = [];
  let cur = [unknownIds[0]];
  for (let i = 1; i < unknownIds.length; i++) {
    if (unknownIds[i] === unknownIds[i - 1] + 1) {
      cur.push(unknownIds[i]);
    } else {
      segments.push(cur);
      cur = [unknownIds[i]];
    }
  }
  segments.push(cur);

  const nBlocks   = moddedBlocks.length;
  const nSegments = segments.length;
  const uncertain = [];
  const fresh     = {};

  if (nSegments === nBlocks) {
    // Perfect 1:1 — high confidence
    for (let i = 0; i < nBlocks; i++) {
      for (const id of segments[i]) {
        fresh[id] = { name: moddedBlocks[i].name, confidence: 'high' };
      }
    }

  } else if (nSegments < nBlocks) {
    // Some blocks haven't appeared in loaded chunks yet
    // Assign segment[i] to moddedBlocks[i] directly — medium confidence
    for (let i = 0; i < nSegments; i++) {
      const block = moddedBlocks[i];
      for (const id of segments[i]) {
        fresh[id] = { name: block.name, confidence: 'medium' };
        uncertain.push({
          stateId: id, name: block.name, confidence: 'medium',
          reason: `${nSegments} segments observed, ${nBlocks} modded blocks — explore more to improve accuracy`,
        });
      }
    }

  } else {
    // More segments than blocks: some block has non-contiguous states observed,
    // or registration order assumption is wrong — proportional split, low confidence
    for (let i = 0; i < unknownIds.length; i++) {
      const bi    = Math.min(Math.floor((i / unknownIds.length) * nBlocks), nBlocks - 1);
      const block = moddedBlocks[bi];
      fresh[unknownIds[i]] = { name: block.name, confidence: 'low' };
      uncertain.push({
        stateId: unknownIds[i], name: block.name, confidence: 'low',
        reason: `${nSegments} segments > ${nBlocks} blocks — check modded-state-ids.json`,
      });
    }
  }

  // Merge: manual overrides and existing high-confidence entries are protected
  let patched = 0;
  for (const [idStr, info] of Object.entries(fresh)) {
    const id = parseInt(idStr);
    if (manualOverrides[id]) continue;
    if (resolved[id]?.confidence === 'high' && info.confidence !== 'high') continue;
    if (!resolved[id] || resolved[id].name !== info.name) { resolved[id] = info; patched++; }
  }

  if (patched > 0) {
    logUncertain(uncertain);
    saveMapping();
    patchRegistryFromResolved(bot);
    console.log(`[REGISTRY] Resolved ${Object.keys(resolved).length} state IDs (${patched} updated, ${nSegments} segments vs ${nBlocks} blocks)`);
  }
}

// ── Registry patcher ──────────────────────────────────────────────────────────

function patchRegistryFromResolved(bot) {
  const byName = {};

  const add = (stateId, name) => {
    if (!byName[name]) byName[name] = [];
    byName[name].push(stateId);
  };

  const manualIds = new Set(Object.keys(manualOverrides).map(Number));

  // Merge resolved and manual mappings
  for (const [id, info] of Object.entries(resolved)) add(parseInt(id), info.name);
  for (const [id, name] of Object.entries(manualOverrides)) add(parseInt(id), name);

  for (const [name, stateIds] of Object.entries(byName)) {
    const sorted = stateIds.sort((a, b) => a - b);
    const isSolidCommon = name.includes('brick') || name.includes('stone') || name.includes('plank');

    const descriptor = {
      id: sorted[0],
      name,
      displayName: name,
      hardness: isSolidCommon ? 1.5 : 1,
      resistance: isSolidCommon ? 6 : 1,
      stackSize: 64,
      diggable: true,
      transparent: !isSolidCommon,
      emitLight: 0,
      filterLight: 15,
      defaultState: sorted[0],
        minStateId: sorted[0],
        maxStateId: sorted[sorted.length - 1],
        states: [],
        // THE FIX: Pathfinder needs 'shapes' to avoid the TypeError
        shapes: isSolidCommon ? [[0, 0, 0, 1, 1, 1]] : [],
        boundingBox: isSolidCommon ? 'block' : 'empty',
    };

    for (const id of sorted) {
      // Force overwrite if it's one of our modded/manual IDs
      if (manualIds.has(id) || resolved[id]) {
        bot.registry.blocksByStateId[id] = descriptor;
      } else if (!bot.registry.blocksByStateId[id]) {
        bot.registry.blocksByStateId[id] = descriptor;
      }
    }

    if (!bot.registry.blocksByName[name]) {
      bot.registry.blocksByName[name] = descriptor;
    }
  }

  // Apply physics overrides — runs after every patch so new descriptors
  // can't undo corrections. Mutates in place so blocksByName and blocksByStateId
  // stay consistent when they share the same descriptor object.
  for (const [name, fix] of Object.entries(BLOCK_PHYSICS)) {
    // Fix the blocksByName entry (vanilla descriptors and any we just wrote)
    const bbn = bot.registry.blocksByName[name];
    if (bbn) Object.assign(bbn, fix);
    // Fix state ID entries we wrote this patch (may be different objects)
    if (byName[name]) {
      for (const id of byName[name]) {
        const bbs = bot.registry.blocksByStateId[id];
        if (bbs) Object.assign(bbs, fix);
      }
    }
  }
}

// ── Chunk palette scanner ─────────────────────────────────────────────────────

function scanColumn(column) {
  let found = 0;
  if (!column?.sections) return found;
  for (const section of column.sections) {
    if (!section) continue;
    // IndirectPaletteContainer: section.palette is an array of global state IDs
    if (Array.isArray(section.palette)) {
      for (const id of section.palette) {
        if (id > vanillaMax && !discovered.has(id)) { discovered.add(id); found++; }
      }
    }
    // SingleValueContainer: section.data.value is the single state ID
    const sv = section.data?.value;
    if (typeof sv === 'number' && sv > vanillaMax && !discovered.has(sv)) {
      discovered.add(sv); found++;
    }
  }
  return found;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Best-known name for a state ID (priority: manual override > resolved > null)
function getModdedBlockName(stateId) {
  if (manualOverrides[stateId]) return manualOverrides[stateId];
  if (resolved[stateId])        return resolved[stateId].name;
  return null;
}

// Confidence for a state ID ('high'/'medium'/'low'/'manual'/null)
function getConfidence(stateId) {
  if (manualOverrides[stateId]) return 'manual';
  return resolved[stateId]?.confidence ?? null;
}

// Persist a manual override and immediately patch the registry
function setManualOverride(bot, stateId, name) {
  manualOverrides[stateId] = name;
  saveManualOverrides();
  patchRegistryFromResolved(bot);
  console.log(`[REGISTRY] Manual override: stateId ${stateId} → ${name}`);
}

// Reverse lookup: find all state IDs currently labeled with a given block name.
// Checks manual overrides, auto-resolved, and the vanilla registry.
function getStateIdsByName(bot, name) {
  const ids = new Set();
  for (const [id, n] of Object.entries(manualOverrides)) {
    if (n === name) ids.add(parseInt(id));
  }
  for (const [id, info] of Object.entries(resolved)) {
    if (info.name === name) ids.add(parseInt(id));
  }
  // Also cover vanilla registry entries (bot may not have them in resolved/overrides)
  const vanilla = bot.registry.blocksByName[name];
  if (vanilla) {
    for (let id = vanilla.minStateId; id <= vanilla.maxStateId; id++) ids.add(id);
  }
  return [...ids];
}

// ── Install ───────────────────────────────────────────────────────────────────

const SYNC_CHANNELS = [
  'fabric-registry-sync-v0:registry_sync',
  'fabric-registry-sync-v1:registry_sync',
  'fabric:registry_sync',
  'fabric-registry-sync-v0:registry/sync',
];

function installRegistryPatch(bot) {
  loadOverrides();

  // Phase 1: capture modded block list from Fabric registry sync
  bot._client.on('custom_payload', (packet) => {
    if (!SYNC_CHANNELS.some(ch => packet.channel === ch)) return;
    const data = packet.data;
    if (!data?.length) return;

    console.log(`[REGISTRY] Sync packet on ${packet.channel} (${data.length} bytes)`);
    const registries = parseFabricRegistrySync(data);
    const blockKey   = Object.keys(registries).find(k => k.includes('block'));
    if (!blockKey) {
      console.warn('[REGISTRY] No block registry in packet. Keys:', Object.keys(registries).join(', '));
      return;
    }

    moddedBlocks = Object.entries(registries[blockKey])
      .filter(([name]) => !name.startsWith('minecraft:'))
      .map(([name, blockId]) => ({ name, blockId }))
      .sort((a, b) => a.blockId - b.blockId);

    console.log(`[REGISTRY] Captured ${moddedBlocks.length} modded block names`);
  });

  // Phase 2: after spawn, record vanilla ceiling and start scanning
  bot.once('spawn', () => {
    vanillaMax = Math.max(...Object.keys(bot.registry.blocksByStateId).map(Number));
    console.log(`[REGISTRY] Vanilla ceiling: stateId ${vanillaMax} | tracking ${moddedBlocks.length} modded blocks`);

    if (Object.keys(manualOverrides).length) patchRegistryFromResolved(bot);

    // Scan already-loaded chunks
    let total = 0;
    for (const { column } of bot.world.getColumns()) total += scanColumn(column);
    if (total > 0) {
      console.log(`[REGISTRY] Found ${total} unknown state IDs from initial chunks`);
      resolveMapping(bot);
    }

    // Debounced resolve on new chunk loads
    let resolveTimer = null;
    bot.world.on('chunkColumnLoad', (pos) => {
      const column = bot.world.getColumn(pos.x >> 4, pos.z >> 4);
      if (!column) return;
      const found = scanColumn(column);
      if (found > 0 && !resolveTimer) {
        resolveTimer = setTimeout(() => {
          resolveTimer = null;
          resolveMapping(bot);
        }, 3000);
      }
    });
  });

  console.log('[REGISTRY] Registry patch installed — waiting for Fabric sync + spawn');
}

module.exports = { installRegistryPatch, getModdedBlockName, getConfidence, setManualOverride, getStateIdsByName };
