const state = require('../state');
const { setBehavior } = require('../behavior');
const { MASTER } = require('../config');
const { cmd } = require('./_util');

const IS_JUMP = cmd([/\bjump(?: \d+ times?)?\b/, /\bpula(?: \d+ vezes?)?\b/]);
const IS_MOVE_DIR = cmd([
  /\bmove (?:forward|backwards?|left|right)\b/,
  /\b(?:go|walk|step) (?:forward|backwards?|left|right)\b/,
  /\banda (?:para frente|para tr[aá]s|para (?:a )?esquerda|para (?:a )?direita)\b/,
  /\bv[aá] (?:para frente|para tr[aá]s|para (?:a )?esquerda|para (?:a )?direita)\b/,
]);
const IS_SPRINT_CMD = cmd([/\bsprint\b/, /\brun forward\b/, /\brun fast\b/, /\bcorre(?:r)?\b/]);
const IS_SPIN = cmd([
  /\bspin(?: around| \d+ times?)?\b/, /\bturn around\b/, /\bdo a spin\b/, /\bdo a 360\b/,
  /\bgira\b/, /\bd[aá] uma volta\b/, /\bda um giro\b/,
]);
const IS_WAVE   = cmd([/\bwave\b/, /\bwave at\b/, /\bswing your arm\b/, /\bacena\b/, /\bbalança o braço\b/]);
const IS_CROUCH = cmd([/\bcrouch\b/, /\bduck\b/, /\bsneak down\b/, /\bagacha\b/, /\babaixa\b/]);
const IS_STAND  = cmd([
  /\bstand up\b/, /\buncrouch\b/, /\bstop sneaking\b/, /\bstop crouching\b/, /\bget up\b/,
  /\blevanta\b/, /\bpara de agachar\b/, /\bfica em p[eé]\b/,
]);
const IS_LOOK_DIR = cmd([
  /\blook (?:up|down|north|south|east|west)\b/,
  /\bolha (?:para cima|para baixo|para o norte|para o sul|para o leste|para o oeste)\b/,
]);
const IS_LOOK_AT_ME_TIMED = cmd([
  /\blook at me for \d+/,
  /\bolha (?:para mim|pra mim) por \d+/,
]);

let lookAtMeTimer = null;

async function handle(bot, lower, raw) {
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
    if (/forward|frente/.test(lower))        dir = 'forward';
    else if (/back|tr[aá]s/.test(lower))     dir = 'back';
    else if (/left|esquerda/.test(lower))    dir = 'left';
    else if (/right|direita/.test(lower))    dir = 'right';
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

  if (IS_LOOK_AT_ME_TIMED(lower)) {
    const secM = lower.match(/for\s+(\d+)/);
    const secs  = secM ? Math.min(parseInt(secM[1]), 60) : 5;

    if (lookAtMeTimer) { clearInterval(lookAtMeTimer); lookAtMeTimer = null; }

    bot.chat(`*looks at you for ${secs}s*`);
    lookAtMeTimer = setInterval(() => {
      const master = bot.players[MASTER]?.entity;
      if (!master?.position) return;
      bot.lookAt(master.position.offset(0, master.height * 0.9, 0), true).catch(() => {});
    }, 50);

    setTimeout(() => {
      clearInterval(lookAtMeTimer);
      lookAtMeTimer = null;
    }, secs * 1000);
    return true;
  }

  if (IS_LOOK_DIR(lower)) {
    const DIRS = {
      up: [null, -1.4], down: [null, 1.4],
      north: [Math.PI, 0], south: [0, 0],
      east: [-Math.PI / 2, 0], west: [Math.PI / 2, 0],
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

  return false;
}

module.exports = { handle };
