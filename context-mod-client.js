// context-mod-client.js — queries the server-side Fabric mod for ground-truth block names.
// The mod exposes GET /blocknames?sids=123,456,... → {"123":"yigd:grave",...}
// Results are fed into registry-patch as 'ground_truth' confidence and compared
// against gap analysis assignments to diagnose mapping errors.

const http  = require('http');
const { applyGroundTruth, getDiscovered, getResolved } = require('./registry-patch');

const HOST     = process.env.CONTEXT_MOD_HOST || '127.0.0.1';
const PORT     = parseInt(process.env.CONTEXT_MOD_PORT || '8080', 10);
const BATCH    = 200;   // max stateIds per HTTP request
const INTERVAL = 15000; // ms between sweeps

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Bad JSON: ' + buf.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function queryBatch(stateIds) {
  if (!stateIds.length) return {};
  const results = {};
  for (let i = 0; i < stateIds.length; i += BATCH) {
    const chunk = stateIds.slice(i, i + BATCH);
    try {
      const data = await httpGet(`/blocknames?sids=${chunk.join(',')}`);
      Object.assign(results, data);
    } catch (err) {
      // Mod not running — don't spam logs, just skip
      if (i === 0) console.log('[CTX-MOD] Not available:', err.message);
      break;
    }
  }
  return results;
}

function installContextModLearner(bot) {
  let consecutive_failures = 0;

  setInterval(async () => {
    const discovered = getDiscovered();
    const resolved   = getResolved();

    // Query all discovered modded stateIds — both unresolved and already-guessed ones.
    // Comparing ground truth against existing guesses is how we diagnose mapper errors.
    const toQuery = [...discovered];
    if (!toQuery.length) return;

    const mappings = await queryBatch(toQuery);
    if (!Object.keys(mappings).length) {
      consecutive_failures++;
      return;
    }
    if (consecutive_failures > 0) {
      console.log('[CTX-MOD] Reconnected to context mod.');
      consecutive_failures = 0;
    }

    applyGroundTruth(bot, mappings);
  }, INTERVAL);

  console.log('[CTX-MOD] Context mod learner installed — polling every', INTERVAL / 1000, 's');
}

module.exports = { installContextModLearner, queryBatch };
