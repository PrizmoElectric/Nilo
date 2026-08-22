const state = require('../state');
const { runCommand } = require('../actions');
const { getPlayerGazeTarget } = require('../gaze');
const { getServerConfig, setActiveServer, getActiveServerName, loadServers, BOT_USERNAME } = require('../config');
const { setManualOverride, getResolved, getDiscovered, getModdedEntityName } = require('../registry-patch');
const { isHostileMob } = require('../combat');
const { LETTA_URL } = require('../config');
const db = require('../db');

const stmtGetEntity = db.prepare('SELECT is_hostile FROM entities WHERE name = ?');
const stmtCountResolved = db.prepare('SELECT COUNT(*) as n FROM state_ids');

async function handle(bot, lower, raw) {
  // "nilo_nilo" — no-op test command
  if (/^nilo_nilo\b/.test(lower)) {
    bot.chat('It does nothing');
    return true;
  }

  // "nilo_help" — condensed category list of everything Nilo responds to.
  // Full detail lives in MANUAL.txt (too long for chat) — this is a quick
  // reference. All of these require the # prefix in normal chat.
  if (/^nilo_help\b/.test(lower)) {
    const lines = [
      'Commands need # in chat (e.g. #follow). Full list: MANUAL.txt',
      'Navigation: follow, come here, closer, stay, sit, wander, explore, unstuck, tp me, look at me',
      'Combat: attack, guard, defensive, passive, use bow, shoot that',
      'Freyr Sword: summon freyr, freyr return, freyr hold, freyr follow, freyr status',
      'Clones: clone N, cloneon/cloneoff, freyr on/off',
      'Mirror: mirror watch, mirror learn, mirror stop',
      'Activities: tunnel, fish, build house, sleep, dance, farm, write sign, mine this, collect grave',
      'Teaching: this is <mod:name>, this / what is this, blockname',
      'Admin (#nilo ...): quit, say, setfarm, setchest, learn, do, skills, forget, queue, autonomous on/off, trust/untrust/trusted',
      'Server: list servers, current server, switch server <name>, save server <name>',
      'Misc: stats, status, sync soul, restart, say <text>, nilo_nilo, nilo_help',
    ];
    for (const l of lines) bot.chat(l);
    return true;
  }

  // "stats" — Nilo's health, hunger, armor, XP
  if (/^stats\b/.test(lower)) {
    const attrVal = (...keys) => {
      let a;
      for (const key of keys) {
        a = bot.entity?.attributes?.[key];
        if (a) break;
      }
      if (!a) return null;
      let v = a.value ?? 0;
      for (const m of a.modifiers ?? []) {
        if (m.operation === 0) v += m.amount;
      }
      let y = v;
      for (const m of a.modifiers ?? []) {
        if (m.operation === 1) y += v * m.amount;
      }
      for (const m of a.modifiers ?? []) {
        if (m.operation === 2) y *= 1 + m.amount;
      }
      return y;
    };

    const maxHp = attrVal('minecraft:generic.max_health', 'generic.max_health') ?? 20;
    const armor = attrVal('minecraft:generic.armor', 'generic.armor') ?? 0;
    const hp     = Math.round((bot.health ?? 0) / maxHp * 100);
    const food   = Math.round((bot.food   ?? 0) / 20   * 100);
    const sat    = Math.round((bot.foodSaturation ?? 0) / 5 * 100);
    const xp     = bot.experience?.level ?? 0;

    bot.chat(`Health: ${hp}% (${Math.round(bot.health ?? 0)}/${Math.round(maxHp)}) | Hunger: ${food}% | Armor: ${Math.round(armor)} | XP: lvl ${xp}`);
    return true;
  }

  // "status" — show what's running
  if (/^status\b/.test(lower)) {
    const lines = [];
    const sc = getServerConfig();
    const { default: fetch } = await import('node-fetch');

    const ping = async (url, timeout = 1500) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        return r.ok ? 'online' : `HTTP ${r.status}`;
      } catch (e) {
        return `offline (${e.message.slice(0, 30)})`;
      }
    };

    // Bot
    const pos = bot.entity?.position;
    const posStr = pos ? `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}` : '?';
    lines.push(`Bot: ${BOT_USERNAME} @ ${posStr} | Behavior: ${state.behaviorMode}`);

    // Mapper
    const nResolved  = Object.keys(getResolved()).length;
    const nDiscovered = getDiscovered().size;
    const nDb = stmtCountResolved.get().n;
    lines.push(`Mapper: ${nResolved} resolved, ${nDiscovered} discovered, ${nDb} in DB`);

    // Services (parallel)
    const [letta, ctxMod, viewer3d, viewerInv] = await Promise.all([
      ping(LETTA_URL.replace(/\/messages$/, ''), 2000),
      ping('http://127.0.0.1:8080/blocknames?sids=1'),
      ping('http://127.0.0.1:3007'),
      ping('http://127.0.0.1:3000'),
    ]);
    lines.push(`Letta: ${letta} | CtxMod: ${ctxMod}`);
    lines.push(`3D view: ${viewer3d} | Inventory: ${viewerInv}`);

    const { DISCORD_TOKEN } = require('../config');
    lines.push(`Discord: ${DISCORD_TOKEN ? 'configured' : 'off'} | Server: ${sc.host}:${sc.port}`);

    for (const l of lines) bot.chat(l);
    return true;
  }
  // "this is <mod:name>" / "that is <mod:name>" — teach Nilo the correct block name for the gaze target
  // Requires a colon in the name (modded blocks only, e.g. yigd:grave, create:cogwheel)
  const teachMatch = lower.match(/^(?:this|that)(?:\s+block)?\s+is\s+(\S+:\S+)/i);
  if (teachMatch) {
    const name = teachMatch[1].toLowerCase();
    try {
      const { block } = getPlayerGazeTarget(bot);
      if (!block) { bot.chat("I don't see a block there."); return true; }
      const sid = block.stateId ?? bot.world.getBlockStateId(block.position);
      setManualOverride(bot, sid, name);
      bot.chat(`Got it — stateId ${sid} is now "${name}".`);
    } catch (err) {
      console.error('[GAZE] teach error:', err.message);
    }
    return true;
  }

  // "rawblock" — debug: dump raw stateId and name for every voxel the ray hits
  if (/^rawblock\b/.test(lower)) {
    const { Vec3 } = require('vec3');
    const { RaycastIterator } = require('prismarine-world').iterators;
    const { MASTER } = require('../config');
    const masterEntity = bot.players[MASTER]?.entity;
    if (!masterEntity?.position) { bot.chat('No player entity.'); return true; }
    const eye = masterEntity.position.offset(0, masterEntity.eyeHeight ?? 1.62, 0);
    const { yaw, pitch } = masterEntity;
    const cp = Math.cos(pitch);
    const dir = new Vec3(-Math.sin(yaw)*cp, Math.sin(pitch), -Math.cos(yaw)*cp).normalize();
    const iter = new RaycastIterator(eye, dir, 8);
    const lines = [];
    let pos;
    while ((pos = iter.next()) && lines.length < 6) {
      const bvec = new Vec3(pos.x, pos.y, pos.z);
      const sid  = bot.world.getBlockStateId(bvec);
      const b    = bot.blockAt(bvec);
      lines.push(`(${pos.x},${pos.y},${pos.z}) sid=${sid} name=${b?.name ?? 'null'}`);
    }
    lines.forEach(l => bot.chat(l));
    return true;
  }

  // "this" / "what is this" / "what am I looking at"
  if (/^this\b/.test(lower) || /\bwhat('s| is) (this|that)\b/.test(lower)
    || /\bwhat am i looking at\b/.test(lower)
    || /\bo que [eé] isso\b/.test(lower) || /\bo que estou (vendo|olhando)\b/.test(lower)) {

  try {
    const { block, entity } = getPlayerGazeTarget(bot);

    if (entity && entity.username === BOT_USERNAME) {
      bot.chat("It's me!"); return true;
    }

    if (entity) {
      // Modded entities have no e.name in mineflayer — resolve via the
      // entity-type cache (Solsai /all-entities ground truth).
      const moddedName = (!entity.name || entity.name === 'unknown') && entity.entityType != null
        ? getModdedEntityName(entity.entityType) : null;
      const name = entity.username || entity.name || moddedName || entity.type || 'unknown';
      const kind = entity.username ? 'player'
      : entity.kind ? entity.kind.toLowerCase()
      : entity.type || 'entity';

      const isHostile = isHostileMob(entity);
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

  // "sync soul" — push soul.txt (system prompt + persona/human memory) to Letta
  if (/\bsync\s+soul\b/.test(lower)) {
    const { syncSoul } = require('../soul');
    try {
      const parts = await syncSoul();
      bot.chat(`Soul synced: ${parts.join(', ')}.`);
    } catch (err) {
      bot.chat(`Soul sync failed: ${err.message}`);
    }
    return true;
  }

  // Restart
  if (/\b(restart|reiniciar|reboot)\b/.test(lower)) {
    const msg = /\breboot\b/.test(lower) ? 'Rebooting...' : 'Restarting...';
    bot.chat(msg);
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
