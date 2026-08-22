#!/usr/bin/env node
// Refreshes nilo-assets/all-items-cache.json from the live Solsai /all-items endpoint.
// Item raw IDs shift whenever the mod loadout/load-order changes, so a stale cache
// causes resolveItemName() to resolve the WRONG item name for a given numeric ID
// (e.g. soulsweapons:freyr_sword moved from raw ID 20340 -> 20341).
// Run after any server mod update: node scripts/fetch-items-cache.js

const http = require('http');
const fs   = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:8080/all-items';
const OUT = path.join(__dirname, '..', 'nilo-assets', 'all-items-cache.json');

http.get(URL, res => {
  const chunks = [];
  res.on('data', d => chunks.push(d));
  res.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const count = Object.keys(data).length;

      let oldFreyr = null;
      try {
        const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
        oldFreyr = Object.entries(old).find(([, v]) => v === 'soulsweapons:freyr_sword')?.[0];
      } catch (_) {}
      const newFreyr = Object.entries(data).find(([, v]) => v === 'soulsweapons:freyr_sword')?.[0];

      fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
      console.log(`Saved ${count} items -> ${OUT}`);
      if (oldFreyr || newFreyr) {
        console.log(`soulsweapons:freyr_sword raw ID: was ${oldFreyr ?? '?'}, now ${newFreyr ?? '?'}`);
      }
    } catch (e) {
      console.error('Failed to parse response:', e.message);
      process.exit(1);
    }
  });
}).on('error', e => {
  console.error('HTTP error:', e.message);
  process.exit(1);
});
