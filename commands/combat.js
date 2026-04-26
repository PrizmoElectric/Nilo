const state = require('../state');
const { setBehavior } = require('../behavior');
const { startAttack, startBowMode, shootAtGazeTarget } = require('../combat');
const skillEngine = require('../skill-engine');
const { MASTER } = require('../config');
const { cmd } = require('./_util');

const IS_ATTACK = cmd([/\battack\b/, /\bataca\b/]);
const IS_GUARD  = cmd([
  /\bguard\b/, /\bguarda\b/, /\bsentinela\b/, /\bvigia\b/, /\bwatch (this |the )?(area|place|spot)\b/,
  /\bprotect (this |the )?(area|place|spot)\b/, /\bkill (any |all )?(mob|mobs|enemies)\b/,
  /\bfique de guarda\b/, /\bfique aqui e ataque\b/,
]);
const IS_DEFENSIVE = cmd([/\bdefensive\b/, /\bdefensivo\b/]);
const IS_PASSIVE   = cmd([/\bpassive\b/, /\bpassivo\b/]);
const IS_BOW = cmd([
  /\buse (the |your )?bow\b/, /\bshoot (with )?bow\b/, /\bsnipe\b/,
  /\b(bow|archer|ranged|sniper) (mode|attack|combat|style)\b/,
  /\bgo (archer|ranged|sniper)\b/, /\barchery\b/,
  /\busa (o )?arco\b/, /\batira com arco\b/, /\bcombate (a )?dist[aâ]ncia\b/, /\barco e flecha\b/,
  /\bmodo arqueiro\b/, /\bataque (a )?dist[aâ]ncia\b/,
]);
const IS_SHOOT_TARGET = cmd([
  /\bshoot (that|it|there|him|her|them)\b/, /\bfire (at )?(that|it|there|him|her|them)\b/,
  /\bsnipe (that|it|him|her|them)\b/, /\btake (the )?shot\b/, /\bshoot where i'?m? looking\b/,
  /\batira (niss?o|nele|nela|l[aá]|naquilo)\b/, /\bfaz o tiro\b/, /\batira a[ií]\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_ATTACK(lower)) {
    startAttack(bot, MASTER);
    return true;
  }

  if (IS_GUARD(lower)) {
    skillEngine.runSkill(bot, 'guard')
      .catch(e => bot.chat(`Guard error: ${e.message}`));
    return true;
  }

  if (IS_DEFENSIVE(lower)) {
    setBehavior(bot, 'defensive', MASTER);
    bot.chat('Defensive mode. I will only fight back.');
    return true;
  }

  if (IS_PASSIVE(lower)) {
    setBehavior(bot, 'passive', MASTER);
    bot.chat('Passive mode. I will not fight.');
    return true;
  }

  if (IS_BOW(lower)) {
    startBowMode(bot);
    return true;
  }

  if (IS_SHOOT_TARGET(lower)) {
    if (state.behaviorMode === 'passive') {
      bot.chat("I'm in passive mode. I won't attack.");
      return true;
    }
    shootAtGazeTarget(bot).catch(err => console.error('[NILO] shoot_target error:', err.message));
    return true;
  }

  return false;
}

module.exports = { handle };
