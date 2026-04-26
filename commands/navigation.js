const Vec3 = require('vec3');
const { goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const state  = require('../state');
const { setBehavior } = require('../behavior');
const { createMovements, startFollow, tryUnstuck } = require('../movement');
const { startAssist } = require('../combat');
const { MASTER } = require('../config');
const { cmd } = require('./_util');

const IS_FOLLOW = cmd([
  /\bfollow\b/,
  /\bme segue\b/, /\bvem comigo\b/, /\bme acompanha\b/, /\bfica comigo\b/,
]);
const IS_HELP = cmd([
  /\bhelp\b/, /\bassist\b/, /\bprotect me\b/, /\bwatch my back\b/, /\bi need help\b/,
  /\bdefend me\b/, /\bguard me\b/, /\bcover me\b/, /\bfight with me\b/, /\bfight for me\b/,
  /\bme ajuda\b/, /\bme ajude\b/, /\bme protege\b/, /\bpreciso de ajuda\b/, /\bme cobre\b/,
  /\bme defende\b/, /\bme escolta\b/,
]);
const IS_COME = cmd([
  /\bcome here\b/, /\bcome closer\b/, /\bget over here\b/, /\bcome to me\b/, /\bget here\b/,
  /\bvem aqui\b/, /\bvem c[aá]\b/, /\bchega aqui\b/, /\bvem at[eé] mim\b/,
  /\bchega mais\b/, /\bvem mais perto\b/, /\baproxima\b/,
]);
const IS_CLOSER = cmd([
  /\bcloser\b/, /\bkeep closer\b/, /\bstay closer\b/, /\bstick closer\b/, /\bget closer\b/,
  /\bfique mais perto\b/, /\bfica mais perto\b/, /\bmais perto\b/,
]);
const IS_UNSTUCK = cmd([
  /\bunstuck\b/, /\bmove away\b/, /\bget out of the way\b/, /\bget unstuck\b/,
  /\bdestravar\b/, /\bsai do caminho\b/, /\bse mexe\b/, /\bmove-te\b/,
]);
const IS_STOP = cmd([
  /\b(go away|leave me|get away|stop following|shoo|back off|give me space)\b/,
  /\b(vai embora|me deixa|sai daqui|vai fora|sai fora|para de me seguir)\b/,
]);
const IS_STOP_FISH = cmd([
  /\bstop fish(ing)?\b/, /\bstop casting\b/, /\bpara de pescar\b/,
]);
const IS_STOP_TUNNEL = cmd([
  /\bstop (tunneling|digging|mining)\b/, /\bcancel (tunnel|digging|mining)\b/,
  /\bpara de (cavar|tunelar|minar)\b/,
]);
const IS_STAY = cmd([
  /\bstay\b/, /\bstop\b/, /\bwait\b/, /\bhold on\b/, /\bdon'?t move\b/,
  /\bfica aqui\b/, /\bpara\b/, /\bespera\b/, /\bn[aã]o se mexa\b/, /\baguarda\b/,
]);
const IS_SIT    = cmd([/\bsit\b/, /\bsenta\b/]);
const IS_WANDER = cmd([/\bwander\b/, /\bvagabundeia\b/]);
const IS_TP_TO_ME = cmd([
  /\btp (to )?me\b/, /\bteleport (to )?me\b/, /\bcome (here|to me) (now|fast|quick|instantly)\b/,
  /\bvem aqui agora\b/, /\btp para mim\b/, /\bteleporta para mim\b/, /\bse teleporta para mim\b/,
]);
const IS_TP_ME_TO_YOU = cmd([
  /\btp me to you\b/, /\bteleport me to you\b/, /\bring me (to you|here)\b/, /\bpull me (to you|here)\b/,
  /\btp eu para (você|vc)\b/, /\bteleporta eu para (você|vc)\b/, /\bme traz para (você|vc)\b/,
]);
const IS_STOP_EXPLORE = cmd([
  /\bstop exploring\b/, /\bdon'?t explore\b/, /\bstop wandering\b/, /\bdon'?t wander\b/,
  /\bpara de explorar\b/, /\bn[aã]o explora\b/, /\bfica parado\b/,
]);
const IS_EXPLORE = cmd([
  /\bgo explore\b/, /\bstart exploring\b/, /\bgo wander\b/, /\bexplore\b/,
  /\bvai explorar\b/, /\bcome[cç]a a explorar\b/, /\bexplora\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_FOLLOW(lower)) {
    bot.setControlState('sneak', false);
    startFollow(bot, MASTER, 2);
    bot.chat('On my way.');
    return true;
  }

  if (IS_HELP(lower)) {
    startAssist(bot, MASTER);
    return true;
  }

  if (IS_COME(lower)) {
    setBehavior(bot, 'idle', MASTER);
    const target = bot.players[MASTER]?.entity;
    if (target) {
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      const pos = target.position;
      bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 2));
    }
    bot.chat('Coming.');
    return true;
  }

  if (IS_CLOSER(lower)) {
    startFollow(bot, MASTER, 1);
    bot.chat('Got it, staying right with you.');
    return true;
  }

  if (IS_UNSTUCK(lower)) {
    bot.chat('Trying to get free...');
    tryUnstuck(bot)
      .then(ok => { if (!ok) bot.chat("Completely stuck. Can you give me a hand?"); })
      .catch(err => console.error('[NILO] Unstuck error:', err.message));
    return true;
  }

  if (IS_STOP(lower)) {
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Backing off.');
    return true;
  }

  // Must be checked before IS_STAY since "stop" matches both
  if (IS_STOP_FISH(lower)) {
    if (state.behaviorMode === 'fishing') {
      setBehavior(bot, 'idle', MASTER);
      bot.deactivateItem();
      bot.chat('Reeling in.');
    }
    return true;
  }

  if (IS_STOP_TUNNEL(lower) || (IS_STAY(lower) && state.behaviorMode === 'tunneling')) {
    if (state.behaviorMode === 'tunneling') {
      setBehavior(bot, 'idle', MASTER);
      bot.chat('Stopping tunnel.');
    }
    return true;
  }

  if (IS_SIT(lower)) {
    setBehavior(bot, 'sit', MASTER);
    bot.setControlState('sneak', true);
    bot.chat('Sitting.');
    return true;
  }

  if (IS_STAY(lower)) {
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Staying here.');
    return true;
  }

  if (IS_WANDER(lower)) {
    setBehavior(bot, 'wander', MASTER);
    bot.chat('Going for a wander.');
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    state.behaviorInterval = setInterval(() => {
      if (state.behaviorMode !== 'wander') return;
      const pos = bot.entity.position;
      const rx  = pos.x + (Math.random() * 20 - 10);
      const rz  = pos.z + (Math.random() * 20 - 10);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(pos.y), Math.floor(rz)));
    }, 5000);
    return true;
  }

  if (IS_TP_TO_ME(lower)) {
    const player = bot.players[MASTER]?.entity;
    if (!player) { bot.chat("I can't see you."); return true; }
    const p = player.position;
    bot.chat(`/tp ${bot.username} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    return true;
  }

  if (IS_TP_ME_TO_YOU(lower)) {
    const p = bot.entity.position;
    bot.chat(`/tp ${MASTER} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    return true;
  }

  if (IS_STOP_EXPLORE(lower)) {
    state.exploringEnabled = false;
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Stopping exploration.');
    return true;
  }

  if (IS_EXPLORE(lower)) {
    state.exploringEnabled = true;
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Going exploring.');
    return true;
  }

  // Look at me
  if (/\b(look at me|look here|olha pra mim|me olha|olha aqui|olha pra c[aá])\b/.test(lower)) {
    const target = bot.players[MASTER]?.entity;
    if (target) await bot.lookAt(target.position.offset(0, target.height, 0));
    return true;
  }

  // Click/activate block at coordinates — "click button at 100 64 200"
  {
    const m = lower.match(/(?:click|press|push|activate|use|aperta|clica|ativa|usa)\b.*?(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
    if (m) {
      const [bx, by, bz] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      const block = bot.blockAt(new Vec3(bx, by, bz));
      if (!block || block.name === 'air') {
        bot.chat(`Nothing at ${bx} ${by} ${bz}.`);
      } else {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new GoalNear(bx, by, bz, 3));
          await bot.lookAt(new Vec3(bx + 0.5, by + 0.5, bz + 0.5), true);
          await bot.activateBlock(block);
          bot.chat('Done.');
        } catch (err) {
          bot.chat("Couldn't reach that.");
          console.error('[NILO] ActivateBlock error:', err.message);
        }
      }
      return true;
    }
  }

  return false;
}

module.exports = { handle };
