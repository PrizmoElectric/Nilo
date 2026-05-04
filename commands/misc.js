const state = require('../state');
const { runCommand } = require('../actions');
const { getPlayerGazeTarget } = require('../gaze');
const { getServerConfig, setActiveServer, getActiveServerName, loadServers } = require('../config');
const db = require('../db');

const stmtGetEntity = db.prepare('SELECT is_hostile FROM entities WHERE name = ?');

async function handle(bot, lower, raw) {
  // "this" / "what is this" / "what am I looking at"
  if (/^this\b/.test(lower) || /\bwhat('s| is) (this|that)\b/.test(lower)
    || /\bwhat am i looking at\b/.test(lower)
    || /\bo que [eé] isso\b/.test(lower) || /\bo que estou (vendo|olhando)\b/.test(lower)) {

  try {
    const { block, entity } = getPlayerGazeTarget(bot);

    if (entity) {
      const name = entity.username || entity.name || entity.type || 'unknown';
      const kind = entity.username ? 'player'
      : entity.kind ? entity.kind.toLowerCase()
      : entity.type || 'entity';

      const dbRow = stmtGetEntity.get((entity.name || '').toLowerCase().replace(/^[a-z_]+:/, ''));
      const isHostile = dbRow !== undefined ? !!dbRow.is_hostile
      : (entity.type === 'hostile' || entity.kind === 'Hostile mobs');

      const hostileTag = entity.username ? '' : (isHostile ? ' [hostile]' : ' [passive]');
      const hp = (entity.health != null) ? ` hp:${Math.round(entity.health)}` : '';
      bot.chat(`${name} (${kind}${hostileTag}${hp})`);
      return true;
    }

    if (block) {
      const sid = block.stateId ?? bot.world.getBlockStateId(block.position);
      const pos = block.position;
      bot.chat(`${block.name} at ${pos.x} ${pos.y} ${pos.z} [sid:${sid}]`);
      return true;
    }

    bot.chat("I don't see anything there.");
    return true;

  } catch (err) {
    console.error('[GAZE] Error:', err.message);
    return true;
  }
  }

  // ── Server switching ────────────────────────────────────────────────────────

  // list servers / what servers / servidores
  if (/\b(list servers?|what servers?|which servers?|servidores?)\b/.test(lower)) {
    const servers = loadServers();
    const names   = Object.keys(servers);
    if (!names.length) { bot.chat('No server profiles found in servers.json.'); return true; }
    const current = getActiveServerName();
    const list = names.map(n => {
      const s = servers[n];
      return `${n}${n === current ? ' [current]' : ''}: ${s.host}:${s.port} v${s.version}${s.description ? ' — ' + s.description : ''}`;
    }).join(' | ');
    bot.chat(list);
    return true;
  }

  // current server / which server
  if (/\b(current server|which server|what server|que servidor|servidor atual)\b/.test(lower)) {
    const sc = getServerConfig();
    bot.chat(`Current server: ${getActiveServerName()} (${sc.host}:${sc.port} v${sc.version})`);
    return true;
  }

  // switch server <name> / connect to <name> / go to <name> / join <name>
  // pt-BR: mudar para o servidor <name> / vai para <name> / conecta em <name>
  const switchMatch = lower.match(
    /\b(?:switch(?:\s+(?:to\s+)?)?server|connect(?:\s+to)?|go\s+to\s+(?:the\s+)?server|join\s+(?:the\s+)?server|mudar\s+(?:para\s+(?:o\s+)?servidor|servidor)|vai\s+para\s+(?:o\s+)?servidor|conecta\s+(?:ao?\s+)?(?:servidor)?)\s+(\S+)/i
  );
  if (switchMatch) {
    const name = switchMatch[1].toLowerCase();
    try {
      setActiveServer(name);
      const sc = getServerConfig();
      bot.chat(`Switching to ${name} (${sc.host}:${sc.port}) — reconnecting in ~10s...`);
      setTimeout(() => bot.quit('server switch'), 500);
    } catch (e) {
      bot.chat(e.message);
    }
    return true;
  }

  // save server <name> <host> <port> <version> — add a profile on the fly
  const saveMatch = lower.match(/\bsave(?:\s+this)?\s+server\s+(?:as\s+)?(\S+)/i)
    || raw.match(/\bsalvar?\s+(?:este\s+)?servidor\s+(?:como\s+)?(\S+)/i);
  if (saveMatch) {
    const { addServer } = require('../config');
    const sc   = getServerConfig();
    const name = saveMatch[1].toLowerCase();
    addServer(name, { host: sc.host, port: sc.port, version: sc.version, auth: sc.auth, description: '' });
    bot.chat(`Saved current server as "${name}".`);
    return true;
  }

  // Restart
  if (/\b(restart|reiniciar|reboot)\b/.test(lower)) {
    bot.chat('Restarting...');
    setTimeout(() => bot.quit('restart'), 500);
    return true;
  }

  // Say / repeat
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

  return false;
}

module.exports = { handle };
