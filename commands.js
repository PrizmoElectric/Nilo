// commands.js — natural language command matchers and handleNaturalCommand

const Vec3 = require('vec3');
const { goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder');
const state  = require('./state');
const { setBehavior } = require('./behavior');
const { createMovements, startFollow, tryUnstuck } = require('./movement');
const { startAttack, startBowMode, shootAtGazeTarget } = require('./combat');
const { collectGrave, startFishing, runFarm, buildSimpleHouse, startDance, sleepInBed, writeSign } = require('./activities');
const { pickupNearestItem, isEquippable, getEquipDestination } = require('./items');
const { equipShield } = require('./combat');
const { runCommand } = require('./actions');
const { startTunnel } = require('./tunnel');
const skillEngine = require('./skill-engine');
const { craftItem, smeltItem, ensureTools, listCraftable } = require('./crafting');
const { MASTER } = require('./config');

// ── Command pattern helpers ───────────────────────────────────────────────────

function cmd(patterns) {
  return lower => patterns.some(p => p.test(lower));
}

const IS_FOLLOW = cmd([
  /\bfollow\b/,
  /\bme segue\b/, /\bvem comigo\b/, /\bme acompanha\b/, /\bfica comigo\b/,
]);
const IS_HELP = cmd([
  /\bhelp\b/, /\bassist\b/, /\bprotect me\b/, /\bwatch my back\b/, /\bi need help\b/,
  /\bme ajuda\b/, /\bme ajude\b/, /\bme protege\b/, /\bpreciso de ajuda\b/, /\bme cobre\b/,
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
const IS_STAY = cmd([
  /\bstay\b/, /\bstop\b/, /\bwait\b/, /\bhold on\b/, /\bdon'?t move\b/,
  /\bfica aqui\b/, /\bpara\b/, /\bespera\b/, /\bn[aã]o se mexa\b/, /\baguarda\b/,
]);
const IS_SIT      = cmd([/\bsit\b/, /\bsenta\b/]);
const IS_WANDER   = cmd([/\bwander\b/, /\bvagabundeia\b/]);
const IS_ATTACK   = cmd([/\battack\b/, /\bataca\b/]);
const IS_DEFENSIVE = cmd([/\bdefensive\b/, /\bdefensivo\b/]);
const IS_PASSIVE  = cmd([/\bpassive\b/, /\bpassivo\b/]);
const IS_STOP_EXPLORE = cmd([
  /\bstop exploring\b/, /\bdon'?t explore\b/, /\bstop wandering\b/, /\bdon'?t wander\b/,
  /\bpara de explorar\b/, /\bn[aã]o explora\b/, /\bfica parado\b/,
]);
const IS_EXPLORE = cmd([
  /\bgo explore\b/, /\bstart exploring\b/, /\bgo wander\b/, /\bexplore\b/,
  /\bvai explorar\b/, /\bcome[cç]a a explorar\b/, /\bexplora\b/,
]);
const IS_FISH = cmd([
  /\bfish\b/, /\bgo fish(ing)?\b/, /\bstart fish(ing)?\b/, /\bcast (the )?line\b/,
  /\bpesca\b/, /\bvai pescar\b/, /\bcome[cç]a a pescar\b/,
]);
const IS_STOP_FISH = cmd([
  /\bstop fish(ing)?\b/, /\bstop casting\b/, /\bpara de pescar\b/,
]);
const IS_BOW = cmd([
  /\buse (the |your )?bow\b/, /\bshoot (with )?bow\b/, /\bsnipe\b/, /\bbow (mode|attack|combat)\b/, /\branged (mode|attack|combat)\b/,
  /\busa (o )?arco\b/, /\batira com arco\b/, /\bcombate (a )?dist[aâ]ncia\b/, /\barco e flecha\b/,
]);
const IS_TUNNEL = cmd([
  /\btunnel\b/, /\bdig (a |the )?(tunnel|forward|ahead)\b/, /\bmine forward\b/,
  /\bbore (a )?tunnel\b/, /\bdig me a tunnel\b/, /\bstart (digging|mining|tunneling)\b/,
  /\bescava(r|ção)?\b/, /\btunela\b/, /\bcava (um )?túnel\b/,
]);
const IS_STOP_TUNNEL = cmd([
  /\bstop (tunneling|digging|mining)\b/, /\bcancel (tunnel|digging|mining)\b/,
  /\bpara de (cavar|tunelar|minar)\b/,
]);
const IS_SHOOT_TARGET = cmd([
  /\bshoot (that|it|there|him|her|them)\b/, /\bfire (at )?(that|it|there|him|her|them)\b/,
  /\bsnipe (that|it|him|her|them)\b/, /\btake (the )?shot\b/, /\bshoot where i'?m? looking\b/,
  /\batira (niss?o|nele|nela|l[aá]|naquilo)\b/, /\bfaz o tiro\b/, /\batira a[ií]\b/,
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

// ── Physical action patterns ──────────────────────────────────────────────────

const IS_JUMP = cmd([
  /\bjump(?: \d+ times?)?\b/,
  /\bpula(?: \d+ vezes?)?\b/,
]);
const IS_MOVE_DIR = cmd([
  /\bmove (?:forward|backwards?|left|right)\b/,
  /\b(?:go|walk|step) (?:forward|backwards?|left|right)\b/,
  /\banda (?:para frente|para tr[aá]s|para (?:a )?esquerda|para (?:a )?direita)\b/,
  /\bv[aá] (?:para frente|para tr[aá]s|para (?:a )?esquerda|para (?:a )?direita)\b/,
]);
const IS_SPRINT_CMD = cmd([
  /\bsprint\b/, /\brun forward\b/, /\brun fast\b/,
  /\bcorre(?:r)?\b/,
]);
const IS_SPIN = cmd([
  /\bspin(?: around| \d+ times?)?\b/, /\bturn around\b/, /\bdo a spin\b/, /\bdo a 360\b/,
  /\bgira\b/, /\bd[aá] uma volta\b/, /\bda um giro\b/,
]);
const IS_WAVE = cmd([
  /\bwave\b/, /\bwave at\b/, /\bswing your arm\b/,
  /\bacena\b/, /\bbalança o braço\b/,
]);
const IS_CROUCH = cmd([
  /\bcrouch\b/, /\bduck\b/, /\bsneak down\b/,
  /\bagacha\b/, /\babaixa\b/,
]);
const IS_STAND = cmd([
  /\bstand up\b/, /\buncrouch\b/, /\bstop sneaking\b/, /\bstop crouching\b/, /\bget up\b/,
  /\blevanta\b/, /\bpara de agachar\b/, /\bfica em p[eé]\b/,
]);
const IS_LOOK_DIR = cmd([
  /\blook (?:up|down|north|south|east|west)\b/,
  /\bolha (?:para cima|para baixo|para o norte|para o sul|para o leste|para o oeste)\b/,
]);

// ── Sign patterns ─────────────────────────────────────────────────────────────

const IS_WRITE_SIGN = cmd([
  /\bwrite (a |on a |on the )?sign\b/, /\bleave (a )?note\b/, /\bput (a )?sign\b/,
  /\bplace (a )?sign\b/, /\bsign (that|here|says?)\b/,
  /\bescreve (num?|no|na|o|a)? sign\b/, /\bdeixa (uma? )?nota\b/, /\bp[oõ]e (um )?(sign|placa)\b/,
]);

// ── Craft / smelt patterns ────────────────────────────────────────────────────

const IS_CRAFT = cmd([
  /\bcraft\b/, /\bmake\b/, /\bbuild (a |an |some )?\w/,
  /\bcreate (a |an |some )?\w/, /\bfabricar?\b/, /\bconstruir?\b/, /\bcraftar?\b/,
]);
const IS_SMELT = cmd([
  /\bsmelt\b/, /\bfurnace\b/, /\bcook (the |some |my )?\w/,
  /\bburn (the |some |my )?\w/,
  /\bfundir?\b/, /\bderretar?\b/, /\bcozinhar?\b/, /\bforja\b/,
]);
const IS_WHAT_CAN_CRAFT = cmd([
  /\bwhat can (i |you |we )?craft\b/, /\bwhat can (i |you |we )?make\b/,
  /\blist (what|all) (i |you )?can (craft|make)\b/,
  /\bshow (me |your )?(craftable|recipes)\b/,
  /\bo que (você |eu |a gente )?pode (craftar|fazer|construir)\b/,
]);
const IS_ENSURE_TOOLS = cmd([
  /\b(craft|make) (me |some )?(basic |missing )?tools?\b/,
  /\bensure tools?\b/, /\bcheck tools?\b/, /\bdo (i|you) have tools?\b/,
  /\b(faz|crafta) (as |umas )?ferramentas?\b/,
]);

// ── Farm patterns ─────────────────────────────────────────────────────────────

const IS_FARM = cmd([
  /\bgo farm\b/, /\bstart farm(ing)?\b/, /\bharvest( the)? crops?\b/,
  /\bdo (a |the )?farm( run)?\b/, /\brun (the )?farm\b/, /\bfarm (the )?crops?\b/,
  /\bvai (para a )?fazenda\b/, /\bcolhe\b/, /\bfaz (a )?fazenda\b/, /\bfarmar\b/,
]);

// ── Skill patterns ────────────────────────────────────────────────────────────

const IS_LEARN_SKILL = cmd([
  /\blearn (how to|to)\b/, /\bteach yourself (to|how to)\b/, /\blearn (the )?skill\b/,
  /\baprende (a|como)\b/, /\baprender (a|como)\b/, /\bensina(-te)? (a|como)\b/,
]);
const IS_RUN_SKILL = cmd([
  /\b(do|run|perform|execute|use) (the |your )?(\w+ )?skill\b/,
  /\b(do|run|perform|execute) (the )?\w+\b/, // broad — filtered below by manifest check
  /\b(faz|executa|usa) (a |o )?skill\b/, /\bexecuta\b/,
]);
const IS_LIST_SKILLS = cmd([
  /\bwhat skills? (do you know|have you learned|can you do)\b/,
  /\b(show|list) (me )?(your |all )?skills?\b/,
  /\bquais skills? (você sabe|você tem|você conhece)\b/,
  /\bmostra (suas |as )?skills?\b/, /\blist(a)? skills?\b/,
]);
const IS_FORGET_SKILL = cmd([
  /\bforget (how to|the skill|skill)?\b/, /\bunlearn\b/, /\bdelete (the )?skill\b/,
  /\besquecer?\b/, /\bapaga (a |o )?(skill|habilidade)\b/,
]);
const IS_QUEUE_GOAL = cmd([
  /\b(add|queue|enqueue) .+ (to (your )?goals?|to (your )?curriculum|as a goal)\b/,
  /\bqueue (a )?goal\b/, /\badiciona .+ (aos? objetivos|ao curriculum)\b/,
]);
const IS_AUTONOMOUS_ON = cmd([
  /\b(start|turn on|enable|activate) autonomous( mode)?\b/,
  /\bautonomous (mode )?on\b/, /\bbe autonomous\b/,
  /\b(ativa|liga|inicia) (o )?modo autônomo\b/,
]);
const IS_AUTONOMOUS_OFF = cmd([
  /\b(stop|turn off|disable|deactivate) autonomous( mode)?\b/,
  /\bautonomous (mode )?off\b/,
  /\b(desativa|desliga|para) (o )?modo autônomo\b/,
]);

// ── Trust management patterns ─────────────────────────────────────────────────

const IS_TRUST = cmd([
  /\btrust\b/,
  /\badd .+ to (?:the )?trusted\b/,
  /\blet .+ (?:give|issue|send) (?:you |nilo )?commands?\b/,
  /\bconfia em\b/, /\badiciona .+ aos? (?:confiados?|lista de confiança)\b/,
]);
const IS_UNTRUST = cmd([
  /\buntrust\b/, /\bdistrust\b/, /\bstop trusting\b/, /\bremove .+ from (?:the )?trusted\b/,
  /\bdon'?t trust\b/, /\bno longer trust\b/,
  /\bpara de confiar\b/, /\btira .+ dos? confiados?\b/, /\bnão confia? em\b/,
]);
const IS_LIST_TRUSTED = cmd([
  /\bwho do you trust\b/, /\blist (?:the )?trusted\b/, /\bshow (?:the )?trusted\b/,
  /\bquem você confia\b/, /\blista (?:de )?confiados?\b/,
]);

// ── Natural language command handler ─────────────────────────────────────────
// Returns true if a command was matched and executed, false to fall through.

async function handleNaturalCommand(bot, lower, raw) {

  if (IS_FOLLOW(lower)) {
    bot.setControlState('sneak', false);
    startFollow(bot, MASTER, 2);
    bot.chat('On my way.');
    return true;
  }

  if (IS_HELP(lower)) {
    setBehavior(bot, 'defensive', MASTER);
    startFollow(bot, MASTER, 3);
    bot.chat('Sticking close. I will fight back if needed.');
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

  if (IS_ATTACK(lower)) {
    startAttack(bot, MASTER);
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

  if (IS_TUNNEL(lower)) {
    const lenMatch = lower.match(/(\d+)/);
    const length   = lenMatch ? Math.min(parseInt(lenMatch[1]), 512) : 32;
    startTunnel(bot, length).catch(err => console.error('[NILO] Tunnel error:', err.message));
    return true;
  }

  if (IS_FISH(lower)) { startFishing(bot); return true; }
  if (IS_BOW(lower))  { startBowMode(bot); return true; }

  if (IS_SHOOT_TARGET(lower)) {
    if (state.behaviorMode === 'passive') {
      bot.chat("I'm in passive mode. I won't attack.");
      return true;
    }
    shootAtGazeTarget(bot).catch(err => console.error('[NILO] shoot_target error:', err.message));
    return true;
  }

  if (IS_BUILD(lower)) { buildSimpleHouse(bot); return true; }
  if (IS_SLEEP(lower)) { sleepInBed(bot); return true; }
  if (IS_DANCE(lower)) { startDance(bot); return true; }

  // ── Physical one-shot actions ─────────────────────────────────────────────

  if (IS_JUMP(lower)) {
    const m = lower.match(/(\d+)/);
    const n = m ? Math.min(parseInt(m[1]), 20) : 1;
    bot.chat(n === 1 ? '*jumps*' : `*jumps ${n} times*`);
    (async () => {
      for (let i = 0; i < n; i++) {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 250));
        bot.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 400));
      }
    })();
    return true;
  }

  if (IS_MOVE_DIR(lower)) {
    let dir = null;
    if (/forward|frente/.test(lower))         dir = 'forward';
    else if (/back|tr[aá]s/.test(lower))      dir = 'back';
    else if (/left|esquerda/.test(lower))     dir = 'left';
    else if (/right|direita/.test(lower))     dir = 'right';
    if (!dir) return false;

    const secM = lower.match(/(\d+)\s*(?:seconds?|s\b)/);
    const secs = secM ? Math.min(parseInt(secM[1]), 10) : 2;

    bot.chat(`Moving ${dir} for ${secs}s.`);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.setControlState(dir, true);
    setTimeout(() => bot.clearControlStates(), secs * 1000);
    return true;
  }

  if (IS_SPRINT_CMD(lower)) {
    const secM = lower.match(/(\d+)\s*(?:seconds?|s\b)/);
    const secs = secM ? Math.min(parseInt(secM[1]), 10) : 3;
    bot.chat('*sprints*');
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    setTimeout(() => bot.clearControlStates(), secs * 1000);
    return true;
  }

  if (IS_SPIN(lower)) {
    const m = lower.match(/(\d+)/);
    const n = m ? Math.min(parseInt(m[1]), 5) : 1;
    bot.chat(n === 1 ? '*spins*' : `*spins ${n} times*`);
    (async () => {
      for (let i = 0; i < n; i++) {
        const steps = 20;
        for (let s = 0; s < steps; s++) {
          await bot.look(bot.entity.yaw + (Math.PI * 2 / steps), bot.entity.pitch, false);
          await new Promise(r => setTimeout(r, 60));
        }
      }
    })();
    return true;
  }

  if (IS_WAVE(lower)) {
    bot.chat('*waves*');
    (async () => {
      for (let i = 0; i < 6; i++) {
        bot.swingArm();
        await new Promise(r => setTimeout(r, 280));
      }
    })();
    return true;
  }

  if (IS_CROUCH(lower)) {
    bot.setControlState('sneak', true);
    bot.chat('*crouches*');
    return true;
  }

  if (IS_STAND(lower)) {
    bot.setControlState('sneak', false);
    if (state.behaviorMode === 'sit') setBehavior(bot, 'idle', MASTER);
    bot.chat('*stands up*');
    return true;
  }

  if (IS_LOOK_DIR(lower)) {
    const DIRS = {
      up: [null, -1.4], down: [null, 1.4],
      north: [Math.PI, 0], south: [0, 0],
      east: [-Math.PI / 2, 0], west: [Math.PI / 2, 0],
      // pt-BR
      cima: [null, -1.4], baixo: [null, 1.4],
      norte: [Math.PI, 0], sul: [0, 0],
      leste: [-Math.PI / 2, 0], oeste: [Math.PI / 2, 0],
    };
    const word = lower.match(/\b(up|down|north|south|east|west|cima|baixo|norte|sul|leste|oeste)\b/)?.[1];
    if (word && DIRS[word]) {
      const [yaw, pitch] = DIRS[word];
      bot.look(yaw ?? bot.entity.yaw, pitch, false).catch(() => {});
    }
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

  // Look at me
  if (/\b(look at me|look here|olha pra mim|me olha|olha aqui|olha pra c[aá])\b/.test(lower)) {
    const target = bot.players[MASTER]?.entity;
    if (target) await bot.lookAt(target.position.offset(0, target.height, 0));
    return true;
  }

  // Eat this
  if (/\b(eat (this|that|it)|come (isso|esse|essa|aqui|ele|ela))\b/.test(lower)) {
    await pickupNearestItem(bot, 8);
    const food = bot.inventory.items().find(i => bot.registry.foodsByName[i.name]);
    if (!food) { bot.chat("I don't have anything to eat."); return true; }
    try { await bot.equip(food, 'hand'); await bot.consume(); bot.chat(`Ate ${food.name}.`); }
    catch (_) { bot.chat("Couldn't eat that."); }
    return true;
  }

  // Equip this/that
  if (/\b(equip this|equip that|equipa isso|equipa ess[ae]|veste ess[ae]|equipa aqui)\b/.test(lower)) {
    await pickupNearestItem(bot, 8);
    const item = bot.inventory.items().find(isEquippable);
    if (!item) { bot.chat("Nothing equippable on me."); return true; }
    const dest = getEquipDestination(item);
    try {
      await bot.equip(item, dest);
      bot.chat(`Equipped ${item.name}.`);
      if (dest === 'hand' && (state.behaviorMode === 'attack' || state.behaviorMode === 'defensive')) equipShield(bot);
    } catch (_) { bot.chat("Couldn't equip that."); }
    return true;
  }

  // Equip named item — "equip iron_sword", "equip my bow", "equip apprentice wand"
  {
    const SKIP = ['this','that','isso','esse','essa','aqui','it'];
    const m = lower.match(/\b(?:equip|hold|wield|equipar?|segura(?:r)?|p[õo]e na m[ãa]o|coloca na m[ãa]o)\b\s+(?:(?:my|the|your|a|an|o|a|um|uma)\s+)?["']?([a-z0-9_][a-z0-9_ ]*?)["']?\s*$/);
    if (m && !SKIP.includes(m[1].trim())) {
      const query = m[1].trim().replace(/\s+/g, '_');
      const inv   = bot.inventory.items();
      const item  = inv.find(i => i.name.includes(query))
        ?? inv.find(i => query.split('_').every(w => i.name.includes(w)));
      if (!item) { bot.chat(`I don't have a ${query}.`); return true; }
      const dest = getEquipDestination(item);
      try {
        await bot.equip(item, dest);
        bot.chat(`Equipped ${item.name}.`);
        if (dest === 'hand' && (state.behaviorMode === 'attack' || state.behaviorMode === 'defensive')) equipShield(bot);
      } catch (_) { bot.chat(`Couldn't equip ${item.name}.`); }
      return true;
    }
  }

  // Unequip and give
  if (/\b(unequip and give me|unequip.*give me|tira e me (da|dá)|tira.*me (da|dá))\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try {
      const target = bot.players[MASTER]?.entity;
      if (target) {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
      }
      await bot.unequip('hand');
      await bot.tossStack(held);
      bot.chat(`Here, ${held.name}.`);
    } catch (_) { bot.chat("Couldn't hand that over."); }
    return true;
  }

  // Unequip
  if (/\b(unequip that|unequip this|tira isso|tira ess[ae]|desequipa isso)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try { await bot.unequip('hand'); bot.chat(`Unequipped ${held.name}.`); }
    catch (_) { bot.chat("Couldn't unequip that."); }
    return true;
  }

  // Grave pickup
  if (/\b(collect (you[r']?|my) grave|get (you[r']?|my) grave|pick( up)? (you[r']?|my) grave(stone)?|go get (you[r']?|my) grave|grab (you[r']?|my) grave|get (you[r']?|my) stuff|grab (you[r']?|my) stuff|go get (you[r']?|my) stuff|pega seu t[uú]mulo|pega sua cova|recupera seus itens|vai pegar seu t[uú]mulo)\b/.test(lower)) {
    bot.chat('Going to get my grave.');
    collectGrave(bot);
    return true;
  }

  // Drop all items
  if (/\b(drop all|drop everything|drop all (your |the )?items?|esvazia (seu |o )?invent[aá]rio|joga tudo fora|larga tudo)\b/.test(lower)) {
    const items = bot.inventory.items();
    if (items.length === 0) { bot.chat("My inventory is empty."); return true; }
    for (const item of items) {
      try { await bot.tossStack(item); } catch (_) {}
    }
    bot.chat('Dropped everything.');
    return true;
  }

  // Drop held item
  if (/\b(drop (the item |it )?in (your|my) hand|drop that|drop what you('re| are) holding|larga o que est[aá] segurando|joga isso fora)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try { await bot.tossStack(held); bot.chat(`Dropped ${held.name}.`); }
    catch (_) { bot.chat("Couldn't drop that."); }
    return true;
  }

  // Drop / give item
  const dropMatch = raw.match(/\b(?:drop|give|toss|throw)(?:\s+me)?\s+(?:your\s+|the\s+|some\s+|a\s+|an\s+)?(\w+)/i)
    || raw.match(/\b(?:me\s+(?:dá|da|passa|joga|manda|larga)|larga\s+(?:o|a|os|as|um|uma)?\s*)(\w+)/i);
  if (dropMatch) {
    const itemName = dropMatch[1].toLowerCase();
    const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName));
    if (!item) { bot.chat(`I don't have any ${itemName}.`); return true; }
    try { await bot.tossStack(item); bot.chat(`Dropped ${item.count}x ${item.name}.`); }
    catch (err) { console.error(`[NILO] Drop failed for ${item.name}:`, err.message); bot.chat("Couldn't drop that."); }
    return true;
  }

  // Say / repeat — "nilo say X", "say X", "repeat after me X"
  const repeatMatch = raw.match(/^(?:nilo[,:]?\s+)?(?:repeat after me[:\s]+|say[:\s]+|fala[:\s]+|repete[:\s]+)"?(.+?)"?\s*$/i);
  if (repeatMatch) {
    const toSay = repeatMatch[1].trim();
    if (toSay.startsWith('/')) {
      runCommand(bot, toSay);
      bot.chat(`Running: ${toSay.slice(0, 50)}`);
    } else {
      bot.chat(toSay);
    }
    return true;
  }

  // ── Sign writing ──────────────────────────────────────────────────────────

  if (IS_WRITE_SIGN(lower)) {
    // "write a sign: hello world" or "leave a note saying I was here"
    const m = raw.match(/(?:sign(?:\s+(?:that|says?|saying))?|note(?:\s+saying)?|write(?:\s+(?:a|on\s+a)\s+sign)?)[:\s]+(.+)/i);
    const text = m ? m[1].trim() : 'Nilo was here';
    writeSign(bot, text).catch(err => console.error('[SIGN] error:', err.message));
    return true;
  }

  // ── Craft / smelt ─────────────────────────────────────────────────────────

  if (IS_WHAT_CAN_CRAFT(lower)) {
    bot.chat(listCraftable(bot));
    return true;
  }

  if (IS_ENSURE_TOOLS(lower)) {
    ensureTools(bot).catch(err => console.error('[CRAFT] ensureTools error:', err.message));
    return true;
  }

  if (IS_SMELT(lower)) {
    // "smelt the iron ore" / "cook 8 iron ore" / "smelt my raw iron"
    const m = raw.match(/(?:smelt|cook|burn|fundir|cozinhar?|derretar?)\s+(?:the |some |my |(\d+)\s+)?([a-z][a-z0-9_ ]*)/i);
    if (m) {
      const count    = m[1] ? parseInt(m[1]) : 1;
      const itemName = m[2].trim();
      smeltItem(bot, itemName, count).catch(err => console.error('[SMELT] error:', err.message));
      return true;
    }
    bot.chat("What should I smelt?");
    return true;
  }

  if (IS_CRAFT(lower)) {
    // "craft 2 wooden planks" / "make a pickaxe" / "build a chest"
    const m = raw.match(/(?:craft|make|build|create|fabricar?|construir?|craftar?)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+|(\d+)\s+)?([a-z][a-z0-9_ ]*)/i);
    if (m) {
      const count    = m[1] ? parseInt(m[1]) : 1;
      const itemName = m[2].trim();
      craftItem(bot, itemName, count).catch(err => console.error('[CRAFT] error:', err.message));
      return true;
    }
    bot.chat("What should I craft?");
    return true;
  }

  // ── Farm ─────────────────────────────────────────────────────────────────

  if (IS_FARM(lower)) {
    runFarm(bot);
    return true;
  }

  // ── Skill engine ──────────────────────────────────────────────────────────

  if (IS_LIST_SKILLS(lower)) {
    const list   = skillEngine.listSkills();
    const chunks = list.match(/.{1,200}(?:\s|$)/g) || [list];
    for (const chunk of chunks) bot.chat(chunk.trim());
    return true;
  }

  if (IS_AUTONOMOUS_OFF(lower)) {
    state.autonomousSkillsEnabled = false;
    bot.chat('Autonomous mode OFF.');
    return true;
  }

  if (IS_AUTONOMOUS_ON(lower)) {
    state.autonomousSkillsEnabled = true;
    bot.chat(`Autonomous mode ON. I will learn new skills when idle. (${skillEngine.skillCount()} skills known)`);
    return true;
  }

  if (IS_FORGET_SKILL(lower)) {
    // Extract skill name: "forget how to jump" → "jump", "forget spin skill" → "spin"
    const m = raw.match(/(?:forget|unlearn|delete skill|apaga skill|esquecer?)\s+(?:how to|the skill|skill|a skill|o skill|a habilidade)?\s*["']?([a-z0-9_][a-z0-9_ ]*)["']?/i);
    if (!m) { bot.chat('Which skill should I forget?'); return true; }
    const name = m[1].trim().replace(/\s+/g, '_').toLowerCase();
    const ok = skillEngine.deleteSkill(name);
    bot.chat(ok ? `Forgot skill: ${name}.` : `No skill named ${name}.`);
    return true;
  }

  if (IS_QUEUE_GOAL(lower)) {
    const m = raw.match(/(?:add|queue|enqueue|adiciona)\s+(.+?)\s+(?:to (?:your )?goals?|to (?:your )?curriculum|as a goal|aos? objetivos|ao curriculum)/i);
    if (!m) { bot.chat('What goal should I queue?'); return true; }
    skillEngine.queueGoal(m[1].trim());
    bot.chat(`Added to curriculum: "${m[1].trim().slice(0, 50)}"`);
    return true;
  }

  if (IS_LEARN_SKILL(lower)) {
    if (state.skillLearnInProgress) { bot.chat('Already learning something. Give me a moment.'); return true; }
    // Extract task: "learn how to jump 5 times" → "jump 5 times"
    const m = raw.match(/(?:learn|teach yourself|aprende?r?|ensina-?te?)\s+(?:how to|to|a|como)?\s*(.+)/i);
    if (!m) { bot.chat('What should I learn?'); return true; }
    const task = m[1].trim();
    state.skillLearnInProgress = true;
    bot.chat(`Learning: ${task}`);
    skillEngine.learnSkill(bot, task)
      .catch(e => { console.error('[SKILL] learnSkill error:', e.message); bot.chat('Something went wrong while learning.'); })
      .finally(() => { state.skillLearnInProgress = false; });
    return true;
  }

  if (IS_RUN_SKILL(lower)) {
    // Only fire if the extracted word is an actual known skill
    const m = raw.match(/(?:do|run|perform|execute|use|faz|executa|usa)\s+(?:the |your |a )?(?:skill\s+)?["']?([a-z0-9_][a-z0-9_ ]*)["']?/i);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, '_').toLowerCase();
      if (skillEngine.hasSkill(name)) {
        bot.chat(`Running skill: ${name}...`);
        skillEngine.runSkill(bot, name)
          .then(({ success, result, error }) => {
            bot.chat(success ? `Done: ${String(result ?? name).slice(0, 60)}` : `Skill failed: ${error}`);
          })
          .catch(e => bot.chat(`Error: ${e.message}`));
        return true;
      }
    }
  }

  // ── Trust management ──────────────────────────────────────────────────────

  if (IS_LIST_TRUSTED(lower)) {
    const { listTrusted } = require('./trust');
    const list = listTrusted().join(', ');
    bot.chat(list ? `I trust: ${list}` : "I don't trust anyone besides you.");
    return true;
  }

  if (IS_UNTRUST(lower)) {
    const { untrustPlayer } = require('./trust');
    const m = raw.match(/(?:untrust|distrust|stop trusting|remove|don'?t trust|no longer trust|para de confiar em|tira|não confia? em)\s+(\S+)/i);
    if (!m) { bot.chat("Who should I stop trusting?"); return true; }
    const name = m[1].replace(/[^a-zA-Z0-9_]/g, '');
    untrustPlayer(name);
    bot.chat(`Got it. I no longer trust ${name}.`);
    return true;
  }

  if (IS_TRUST(lower)) {
    const { trustPlayer } = require('./trust');
    const m = raw.match(/(?:trust|confia em|adiciona)\s+(\S+)/i);
    if (!m) { bot.chat("Who should I trust?"); return true; }
    const name = m[1].replace(/[^a-zA-Z0-9_]/g, '');
    if (!name) { bot.chat("Who should I trust?"); return true; }
    trustPlayer(name);
    bot.chat(`Okay, I now trust ${name}.`);
    return true;
  }

  return false;
}

module.exports = { handleNaturalCommand };
