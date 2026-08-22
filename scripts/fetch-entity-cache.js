#!/usr/bin/env node
// Fetches the full entity type registry (with Mojang's spawn-group ground truth)
// from the running Solsai mod (port 8080) and saves it to
// nilo-assets/all-entities-cache.json.
// Shape: {"546":{"name":"soulsweapons:freyr_sword_entity","group":"misc","hostile":false},...}
// Run after server restart: node scripts/fetch-entity-cache.js

const http = require('http');
const fs   = require('fs');
const path = require('path');

const URL     = 'http://127.0.0.1:8080/all-entities';
const OUT     = path.join(__dirname, '..', 'nilo-assets', 'all-entities-cache.json');

http.get(URL, res => {
  const chunks = [];
  res.on('data', d => chunks.push(d));
  res.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const count = Object.keys(data).length;
      fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
      console.log(`Saved ${count} entity types → ${OUT}`);

      // Print soulsweapons entries so we can confirm Freyr's numeric ID + hostility
      const freyrEntries = Object.entries(data).filter(([, v]) => v.name.includes('soulsweapons'));
      if (freyrEntries.length) {
        console.log('\nsoulsweapons entities:');
        for (const [id, info] of freyrEntries) {
          console.log(`  ${id}: ${info.name}  group=${info.group}  hostile=${info.hostile}`);
        }
      }

      const hostileCount = Object.values(data).filter(v => v.hostile).length;
      console.log(`\n${hostileCount} entity types classified as hostile (group=monster)`);
    } catch (e) {
      console.error('Failed to parse response:', e.message);
      process.exit(1);
    }
  });
}).on('error', e => {
  console.error('HTTP error:', e.message);
  console.error('Is the Minecraft server running with Solsai 1.9.0 deployed?');
  process.exit(1);
});
