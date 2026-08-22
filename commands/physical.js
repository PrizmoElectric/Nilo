const state    = require('../state');
const { setBehavior } = require('../behavior');
const { MASTER } = require('../config');
const { cmd } = require('./_util');

const IS_JUMP = cmd([/\bjump(?: \d+ times?)?\b/, /\bpula(?: \d+ vezes?)?\b/]);
// Precise distance stepping ("step 2 forward" / "step forward 2 blocks") —
// checked before IS_MOVE_DIR below since "step forward 2" would otherwise
// also match that looser, time-based pattern.
const IS_STEP_DIST = cmd([
  /\bstep\s+\d+\s+(?:fo(?:r)?ward|back(?:wards)?|left|right)\b/i,
  /\bstep\s+(?:fo(?:r)?ward|back(?:wards)?|left|right)\s+\d+\b/i,
  /\bpassos?\s+\d+\s+para\s+(?:frente|tr[aá]s|(?:a\s+)?esquerda|(?:a\s+)?direita)\b/i,
  /\bandar?\s+\d+\s+passos?\s+para\s+(?:frente|tr[aá]s|(?:a\s+)?esquerda|(?:a\s+)?direita)\b/i,
]);
const IS_MOVE_DIR = cmd([
  /\bmove (?:fo(?:r)?ward|backwards?|left|right)\b/,
  /\b(?:go|walk|step) (?:fo(?:r)?ward|backwards?|left|right)\b/,
  /\banda (?:para frente|para tr[aá]s|para (?:a )?esquerda|para (?:a )?direita)\b/,
  /\bv[aá] (?:para frente|para tr[aá]s|para (?:a )?esquerda|para (?:a )?direita)\b/,
]);
const IS_SPRINT_CMD = cmd([/\bsprint\b/, /\brun forward\b/, /\brun fast\b/, /\bcorre(?:r)?\b/]);
const IS_SPIN = cmd([
  /\bspin[lr]?\b/, /\bspin (?:left|right)\b/,
  /\bturn around\b/, /\bdo a spin\b/, /\bdo a 360\b/,
  /\bgira\b/, /\bd[aá] uma volta\b/, /\bda um giro\b/,
]);
const IS_WAVE   = cmd([/\bwave\b/, /\bwave at\b/, /\bswing your arm\b/, /\bacena\b/, /\bbalança o braço\b/]);
const IS_CROUCH = cmd([/\bcrouch\b/, /\bduck\b/, /\bsneak\b/, /\bagacha\b/, /\babaixa\b/]);
const IS_STAND  = cmd([
  /\bstand up\b/, /\buncrouch\b/, /\bstop sneaking\b/, /\bstop crouching\b/, /\bget up\b/,
  /\blevanta\b/, /\bpara de agachar\b/, /\bfica em p[eé]\b/,
]);
const IS_LOOK_DIR = cmd([
  /\blook (?:up|down|north|south|east|west|left|right)\b/,
  /\bolha (?:para cima|para baixo|para o norte|para o sul|para o leste|para o oeste|para (?:a )?esquerda|para (?:a )?direita)\b/,
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
        if (state.isSneaking) bot.setControlState('sneak', true);
        await new Promise(r => setTimeout(r, 400));
      }
    })();
    return true;
  }

  if (IS_STEP_DIST(lower)) {
    const numMatch = lower.match(/\d+/);
    const blocks = numMatch ? Math.min(parseInt(numMatch[0]), 20) : 1;

    let dir = null;
    if (/fo(?:r)?ward|frente/.test(lower))        dir = 'forward';
    else if (/back|tr[aá]s/.test(lower))     dir = 'back';
    else if (/left|esquerda/.test(lower))    dir = 'left';
    else if (/right|direita/.test(lower))    dir = 'right';
    if (!dir) return false;

    bot.chat(`*steps ${blocks} block${blocks === 1 ? '' : 's'} ${dir}*`);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    const startPos = bot.entity.position.clone();
    bot.setControlState(dir, true);

    const restoreSneak = () => { if (state.isSneaking) bot.setControlState('sneak', true); };

    const checkInterval = setInterval(() => {
      if (bot.entity.position.distanceTo(startPos) >= blocks) {
        clearInterval(checkInterval);
        clearTimeout(safety);
        bot.clearControlStates();
        restoreSneak();
      }
    }, 50);

    // Safety timeout in case something blocks the path (wall, gap, etc.)
    const safety = setTimeout(() => {
      clearInterval(checkInterval);
      bot.clearControlStates();
      restoreSneak();
    }, blocks * 1500 + 2000);

    return true;
  }

  if (IS_MOVE_DIR(lower)) {
    let dir = null;
    if (/fo(?:r)?ward|frente/.test(lower))        dir = 'forward';
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
    const goRight = /spinr\b|spin right\b/.test(lower);
    const dir = goRight ? -1 : 1; // left = +yaw in mineflayer
    const degM = lower.match(/(\d+)/);
    const degrees = degM ? Math.min(parseInt(degM[1]), 1080) : 360;
    const radians = degrees * Math.PI / 180;
    const steps = 20;
    const stepAngle = dir * radians / steps;
    const dirLabel = goRight ? 'right' : 'left';
    bot.chat(degrees === 360 ? `*spins ${dirLabel}*` : `*spins ${dirLabel} ${degrees}°*`);
    (async () => {
      for (let s = 0; s < steps; s++) {
        await bot.look(bot.entity.yaw + stepAngle, bot.entity.pitch, false);
        await new Promise(r => setTimeout(r, 60));
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
    state.isSneaking = true;
    bot.setControlState('sneak', true);
    bot.chat('*crouches*');
    return true;
  }

  if (IS_STAND(lower)) {
    state.isSneaking = false;
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
    const word = lower.match(/\b(up|down|north|south|east|west|left|right|cima|baixo|norte|sul|leste|oeste|esquerda|direita)\b/)?.[1];
    if (!word) return false;
    const numMatch = lower.match(/(\d+)/);
    const degrees  = numMatch ? Math.min(parseInt(numMatch[1]), 180) : null;

    // left/right have no absolute compass equivalent — always relative to
    // current facing, same yaw convention as IS_SPIN (left = +yaw).
    if (word === 'left' || word === 'esquerda' || word === 'right' || word === 'direita') {
      const dir = (word === 'left' || word === 'esquerda') ? 1 : -1;
      const deg = degrees ?? 90;
      const newYaw = bot.entity.yaw + dir * deg * Math.PI / 180;
      bot.look(newYaw, bot.entity.pitch, false).catch(() => {});
      return true;
    }

    // "look up 30" / "look down 20" — relative pitch delta by N degrees.
    // Bare "look up"/"look down" (no number) keeps the old fixed extreme
    // angle below, unchanged.
    if (degrees != null && (word === 'up' || word === 'cima' || word === 'down' || word === 'baixo')) {
      const dir = (word === 'up' || word === 'cima') ? -1 : 1;
      const newPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.entity.pitch + dir * degrees * Math.PI / 180));
      bot.look(bot.entity.yaw, newPitch, false).catch(() => {});
      return true;
    }

    const DIRS = {
      up: [null, -1.4], down: [null, 1.4],
      north: [Math.PI, 0], south: [0, 0],
      east: [-Math.PI / 2, 0], west: [Math.PI / 2, 0],
      cima: [null, -1.4], baixo: [null, 1.4],
      norte: [Math.PI, 0], sul: [0, 0],
      leste: [-Math.PI / 2, 0], oeste: [Math.PI / 2, 0],
    };
    if (DIRS[word]) {
      const [yaw, pitch] = DIRS[word];
      bot.look(yaw ?? bot.entity.yaw, pitch, false).catch(() => {});
    }
    return true;
  }

  return false;
}

module.exports = { handle };
