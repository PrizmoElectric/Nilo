const { collectGrave, startFishing, runFarm, buildSimpleHouse, startDance, sleepInBed, writeSign } = require('../activities');
const { startTunnel } = require('../skills/tunnel');
const { cmd } = require('./_util');

const IS_TUNNEL = cmd([
  /\btunnel\b/, /\bdig (a |the )?(tunnel|forward|ahead)\b/, /\bmine forward\b/,
  /\bbore (a )?tunnel\b/, /\bdig me a tunnel\b/, /\bstart (digging|mining|tunneling)\b/,
  /\bescava(r|ção)?\b/, /\btunela\b/, /\bcava (um )?túnel\b/,
]);
const IS_FISH = cmd([
  /\bfish\b/, /\bgo fish(ing)?\b/, /\bstart fish(ing)?\b/, /\bcast (the )?line\b/,
  /\bpesca\b/, /\bvai pescar\b/, /\bcome[cç]a a pescar\b/,
]);
const IS_BUILD = cmd([
  /\bbuild (a |me a )?(quick |small |simple )?(house|shelter|hut|base)\b/,
  /\bconstro[ií] (uma )?(casa|cabana|abrigo|base)\b/,
  /\bconstruir (uma )?(casa|cabana|abrigo|base)\b/,
]);
const IS_SLEEP = cmd([
  /\bsleep\b/, /\bgo to sleep\b/, /\bsleep in (that|the|this) bed\b/, /\buse (the |that |this )?bed\b/,
  /\bdormir?\b/, /\bdeita\b/, /\bdorme na cama\b/, /\busa a cama\b/,
]);
const IS_DANCE = cmd([
  /\bdance\b/, /\bstart danc(ing)?\b/, /\bdo (a )?dance\b/, /\bshow (me )?your (moves|dance)\b/,
  /\bdanc[ae]\b/, /\bdan[cç]ar\b/, /\bmostra (seus )?passos\b/,
]);
const IS_FARM = cmd([
  /\bgo farm\b/, /\bstart farm(ing)?\b/, /\bharvest( the)? crops?\b/,
  /\bdo (a |the )?farm( run)?\b/, /\brun (the )?farm\b/, /\bfarm (the )?crops?\b/,
  /\bvai (para a )?fazenda\b/, /\bcolhe\b/, /\bfaz (a )?fazenda\b/, /\bfarmar\b/,
]);
const IS_WRITE_SIGN = cmd([
  /\bwrite (a |on a |on the )?sign\b/, /\bleave (a )?note\b/, /\bput (a )?sign\b/,
  /\bplace (a )?sign\b/, /\bsign (that|here|says?)\b/,
  /\bescreve (num?|no|na|o|a)? sign\b/, /\bdeixa (uma? )?nota\b/, /\bp[oõ]e (um )?(sign|placa)\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_TUNNEL(lower)) {
    const lenMatch = lower.match(/(\d+)/);
    const length   = lenMatch ? Math.min(parseInt(lenMatch[1]), 512) : 32;
    startTunnel(bot, length).catch(err => console.error('[NILO] Tunnel error:', err.message));
    return true;
  }

  if (IS_FISH(lower))  { startFishing(bot); return true; }
  if (IS_BUILD(lower)) { buildSimpleHouse(bot); return true; }
  if (IS_SLEEP(lower)) { sleepInBed(bot); return true; }
  if (IS_DANCE(lower)) { startDance(bot); return true; }
  if (IS_FARM(lower))  { runFarm(bot); return true; }

  if (IS_WRITE_SIGN(lower)) {
    const m = raw.match(/(?:sign(?:\s+(?:that|says?|saying))?|note(?:\s+saying)?|write(?:\s+(?:a|on\s+a)\s+sign)?)[:\s]+(.+)/i);
    const text = m ? m[1].trim() : 'Nilo was here';
    writeSign(bot, text).catch(err => console.error('[SIGN] error:', err.message));
    return true;
  }

  // Grave pickup
  if (/\b(collect (you[r']?|my) grave|get (you[r']?|my) grave|pick( up)? (you[r']?|my) grave(stone)?|go get (you[r']?|my) grave|grab (you[r']?|my) grave|get (you[r']?|my) stuff|grab (you[r']?|my) stuff|go get (you[r']?|my) stuff|pega seu t[uú]mulo|pega sua cova|recupera seus itens|vai pegar seu t[uú]mulo)\b/.test(lower)) {
    bot.chat('Going to get my grave.');
    collectGrave(bot);
    return true;
  }

  return false;
}

module.exports = { handle };
