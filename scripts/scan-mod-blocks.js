// scan-mod-blocks.js — extract modded block names sorted by Fabric load order
// Usage: node scan-mod-blocks.js [mods_dir]

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const modsDir = process.argv[2] || '/home/prizmo/mc-prominence2/data/mods';
const outFile = path.join(__dirname, '..', 'mod-block-list.json');
const jars    = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));

// ── Pass 1: read fabric.mod.json + blockstate list from each jar ──────────────
const mods = {};  // modid → { blocks: [], deps: [] }

for (const jar of jars) {
  const full = path.join(modsDir, jar);
  let listing;
  try {
    listing = execSync(`unzip -l "${full}"`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  } catch (_) { continue; }

  // Get mod ID from fabric.mod.json
  let modId = null;
  let deps  = [];
  if (listing.includes('fabric.mod.json')) {
    try {
      const raw  = execSync(`unzip -p "${full}" fabric.mod.json`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
      const meta = JSON.parse(raw);
      modId = meta.id;
      deps  = Object.keys(meta.depends || {}).concat(Object.keys(meta.recommends || {}))
                .filter(d => d !== 'fabricloader' && d !== 'minecraft' && d !== 'java');
    } catch (_) {}
  }

  // Collect block names from blockstate paths
  const blocks = [];
  for (const line of listing.split('\n')) {
    const m = line.match(/assets\/([a-z0-9_.-]+)\/blockstates\/([a-z0-9_./-]+)\.json/);
    if (!m) continue;
    const ns = m[1];
    if (ns === 'minecraft') continue;
    const name = `${ns}:${m[2].replace(/\//g, '_')}`;
    // Resolve mod ID: prefer fabric.mod.json id, fall back to namespace
    if (!modId) modId = ns;
    blocks.push(name);
  }

  if (blocks.length === 0) continue;
  if (!mods[modId]) mods[modId] = { blocks: [], deps: [] };
  mods[modId].blocks.push(...blocks);
  mods[modId].deps = deps;
}

// Deduplicate blocks within each mod
for (const m of Object.values(mods)) m.blocks = [...new Set(m.blocks)].sort();

// ── Pass 2: topological sort of mods by dependency graph ─────────────────────
const allIds   = Object.keys(mods);
const visited  = new Set();
const ordered  = [];

function visit(id) {
  if (visited.has(id)) return;
  visited.add(id);
  for (const dep of (mods[id]?.deps || [])) visit(dep);
  if (mods[id]) ordered.push(id);
}
allIds.sort().forEach(visit);  // alphabetical within same topo level

// ── Pass 3: build final ordered block list ────────────────────────────────────
const list = [];
for (const id of ordered) {
  list.push(...(mods[id]?.blocks || []));
}

// Append any that weren't reached (no fabric.mod.json, namespace mismatch, etc.)
const seen = new Set(list);
for (const id of allIds) {
  for (const b of (mods[id]?.blocks || [])) {
    if (!seen.has(b)) { list.push(b); seen.add(b); }
  }
}

fs.writeFileSync(outFile, JSON.stringify(list, null, 2));
console.log(`Scanned ${jars.length} jars — ${list.length} modded blocks in load order → ${outFile}`);
