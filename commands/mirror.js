// commands/mirror.js — mirror / watch mode commands

const { startWatch, startLearn, stopMirror, getMirrorStatus } = require('../mirror');
const fs   = require('fs');
const path = require('path');

const IS_WATCH  = /\b(mirror\s+watch|watch\s+mode|just\s+watch\s+(me|you))\b/;
const IS_LEARN  = /\b(mirror\s+(me|start|on)|copy\s+me|imitate\s+me|follow\s+and\s+(copy|mirror|record))\b/;
const IS_STOP   = /\b(mirror\s+(stop|off)|stop\s+mirror(ing)?)\b/;
const IS_LIST   = /\bmirror\s+list\b/;
const IS_STATUS = /\bmirror\s+status\b/;

function handle(bot, lower, raw, username) {
  if (IS_WATCH.test(lower)) {
    startWatch(bot);
    return true;
  }

  if (IS_LEARN.test(lower)) {
    startLearn(bot);
    return true;
  }

  if (IS_STOP.test(lower)) {
    stopMirror(bot);
    return true;
  }

  if (IS_LIST.test(lower)) {
    const dir = path.join(__dirname, '..', 'mirrors');
    if (!fs.existsSync(dir)) { bot.chat('No recordings yet.'); return true; }
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort().reverse().slice(0, 8);
    if (files.length === 0) { bot.chat('No recordings yet.'); return true; }
    bot.chat('Recordings: ' + files.join(', '));
    return true;
  }

  if (IS_STATUS.test(lower)) {
    const s = getMirrorStatus();
    if (!s) { bot.chat('Not mirroring.'); return true; }
    if (s.mode === 'watch') {
      bot.chat('Watch mode — observing, not recording.');
    } else {
      bot.chat(`Mirror mode — ${s.events} events, ${s.duration}s, file: ${s.file}`);
    }
    return true;
  }

  return false;
}

module.exports = { handle };
