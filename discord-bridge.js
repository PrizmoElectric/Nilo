// discord-bridge.js — two-way bridge between Nilo's Minecraft chat and Discord
//
// Discord → Minecraft:
//   Messages in the bridge channel from MASTER's Discord account are forwarded
//   to handleNaturalCommand (same pipeline as in-game chat). Other authorized
//   users get basic command access (#follow, #stay, #status, etc.).
//
// Minecraft → Discord:
//   Nilo's chat responses, player chat, deaths, respawns, and status events
//   are posted to the bridge channel.
//
// Offline mode:
//   Discord is started at boot, independently of Minecraft. When Nilo is not
//   in-game, MASTER can still have a conversation via Letta — game commands and
//   actions are silently skipped.
//
// Setup (before first run):
//   1. Create a Discord bot at https://discord.com/developers/applications
//   2. Give it: Send Messages, Read Message History, View Channels intents +
//      Server Members Intent and Message Content Intent (Privileged)
//   3. Set environment variables (or edit config.js directly):
//        DISCORD_TOKEN      — bot token
//        DISCORD_CHANNEL_ID — channel ID to bridge
//        DISCORD_MASTER_ID  — your Discord user ID (right-click → Copy User ID)

'use strict';

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const state = require('./state');
const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_MASTER_ID, BOT_USERNAME, MASTER,
        getServerConfig, getActiveServerName, setActiveServer, loadServers, addServer } = require('./config');

let discordClient  = null;
let bridgeChannel  = null;
let _botRef        = null;  // set on init
let lastAwakeNoticeTime = 0; // when "NILO is awake" last posted — suppresses a redundant "joined Minecraft" right after
const JOIN_NOTICE_SUPPRESS_MS = 5 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isEnabled() {
  return !!(DISCORD_TOKEN && DISCORD_CHANNEL_ID);
}

// Post a message to the bridge channel, silently drop if not ready.
async function toDiscord(text) {
  if (!bridgeChannel) return;
  try {
    // Split messages longer than 1900 chars (Discord limit is 2000)
    const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
    for (const chunk of chunks) await bridgeChannel.send(chunk);
  } catch (err) {
    console.error('[DISCORD] Send error:', err.message);
  }
}

// Format a Minecraft → Discord line
function mcLine(username, message) {
  return `**[MC]** \`${username}\` ${message}`;
}

// ── Status command ────────────────────────────────────────────────────────────

// Formats a millisecond duration as "Xh Ym" / "Xm Ys" / "Xs".
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function buildStatusEmbed(bot) {
  const sc       = getServerConfig();
  const target   = `${sc.host}:${sc.port}`;
  const srvName  = getActiveServerName();
  const now      = Date.now();

  if (!bot) {
    const lines = [
      '```',
      `NILO STATUS — Minecraft: OFFLINE`,
      `Target     : ${srvName} (${target})`,
    ];
    const err = state.lastConnectionError;
    if (err) lines.push(`Last error : ${err.code || err.message} (${formatDuration(now - err.time)} ago)`);
    const downSince = state.lastDisconnectTime || state.bootTime;
    lines.push(`Down for   : ${formatDuration(now - downSince)}`);
    if (state.reconnectAttempts > 0) lines.push(`Reconnect  : attempt #${state.reconnectAttempts}, retrying every 10s`);
    lines.push(`Letta chat : still works here — only the in-game connection is down.`);
    lines.push('```');
    return lines.join('\n');
  }

  const pos    = bot.entity?.position;
  const posStr = pos ? `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : 'unknown';
  const health = bot.health != null ? `${Math.round(bot.health)}/20` : 'unknown';
  const food   = bot.food   != null ? `${bot.food}/20` : 'unknown';
  const mode   = state.behaviorMode || 'idle';
  const skills = (() => { try { return require('./skill-engine').skillCount(); } catch(_) { return '?'; } })();
  const auto     = state.autonomousSkillsEnabled ? 'ON' : 'OFF';
  const explore  = state.exploringEnabled ? 'ON' : 'OFF';
  const internet = state.internetEnabled ? 'ON' : 'OFF';
  const upFor    = state.connectedSince ? formatDuration(now - state.connectedSince) : 'unknown';

  // Freyr Sword
  let freyr = 'none';
  try {
    const { findFreyrEntity, hasFreyrItem, isStationary } = require('./freyr');
    if (findFreyrEntity(bot)) freyr = isStationary(bot) ? 'summoned, holding position' : 'summoned, following';
    else if (hasFreyrItem(bot)) freyr = 'in inventory';
  } catch (_) {}

  // MASTER presence/distance
  const masterPlayer = bot.players[MASTER];
  let masterLine = 'offline';
  if (masterPlayer?.entity && pos) masterLine = `online, ${Math.round(pos.distanceTo(masterPlayer.entity.position))} blocks away`;
  else if (masterPlayer) masterLine = 'online, not in render distance';

  const lines = [
    '```',
    `NILO STATUS — Minecraft: ONLINE`,
    `Server     : ${srvName} (${target})`,
    `Connected  : ${upFor}`,
    `Position   : ${posStr}`,
    `Health     : ${health}    Food: ${food}`,
    `Mode       : ${mode}`,
    `Exploring  : ${explore}    Autonomous: ${auto}    Internet: ${internet}`,
    `Skills     : ${skills} learned`,
    `Freyr Sword: ${freyr}`,
    `Master     : ${MASTER} — ${masterLine}`,
  ];

  // Clone army (only shown when relevant)
  if (state.cloneModeActive) {
    const count = (() => { try { return require('./clones').clones.size; } catch(_) { return 0; } })();
    lines.push(`Clones     : ${count} active (Freyr: ${state.freyrCloneToggle ? 'on' : 'off'})`);
  }

  lines.push('```');
  return lines.join('\n');
}

// ── Discord → Minecraft command handler ──────────────────────────────────────

async function handleDiscordMessage(message) {
  state.discordContext = true;
  try {
    await _handleDiscordMessage(message);
  } finally {
    state.discordContext = false;
  }
}

async function _handleDiscordMessage(message) {
  const bot      = _botRef;  // may be null if Nilo is offline
  const isMaster = message.author.id === DISCORD_MASTER_ID;
  const speakerName = message.author.username; // who's actually typing — never assume it's MASTER
  const content  = message.content.trim();
  const lower    = content.toLowerCase();

  // Resolve Discord reply reference — prepend quoted context so Letta sees it
  let replyContext = '';
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      const who  = ref.author.id === discordClient.user.id ? 'Nilo' : ref.author.username;
      const body = ref.content.replace(/^\*\*NILO:\*\*\s*/i, '').trim().slice(0, 300);
      replyContext = `[Replying to ${who}: "${body}"]\n`;
    } catch (_) {}
  }

  // #status — anyone in the channel can check
  if (lower === '#status' || lower === '#nilo status') {
    await toDiscord(buildStatusEmbed(bot));
    return;
  }

  // #skills — list learned skills
  if (lower === '#skills' || lower === '#nilo skills') {
    const list = require('./skill-engine').listSkills();
    await toDiscord(`**Skills:** ${list}`);
    return;
  }

  // MASTER-only direct commands (no Letta, instant response)
  if (isMaster) {
    // ── Help ─────────────────────────────────────────────────────────────────
    if (lower === '#help') {
      await toDiscord(
        '**NILO Master commands**\n' +
        '`#autonomous on/off` — toggle autonomous behavior\n' +
        '`#skill list` — list skills\n' +
        '`#skill learn <task>` — learn a new skill\n' +
        '`#skill run <name>` — run a skill\n' +
        '`#skill forget <name>` — delete a skill\n' +
        '`#goal <task>` — queue a goal\n' +
        '`#trust <player>` / `#untrust <player>` — manage trust\n' +
        '`#trusted` — list trusted players\n' +
        '`#behavior <mode>` / `#behavior clear` — set behavior\n' +
        '`#server list` — show server profiles\n' +
        '`#server add <name> <host> [port]` — add profile and connect immediately\n' +
        '`#server switch <name>` — switch Minecraft server\n' +
        '`#server save <name>` — save current server as a profile\n' +
        '`#status` / `#skills` — status & skill list\n' +
        '_Or just talk naturally — Nilo understands you._'
      );
      return;
    }

    // ── Autonomous ──────────────────────────────────────────────────────────
    if (/^#autonomous\s+(on|off)$/i.test(lower)) {
      state.autonomousSkillsEnabled = /on/i.test(lower);
      await toDiscord(`Autonomous mode: **${state.autonomousSkillsEnabled ? 'ON' : 'OFF'}**`);
      return;
    }

    // ── Skills ───────────────────────────────────────────────────────────────
    if (/^#skill\s+list$/i.test(lower)) {
      const list = require('./skill-engine').listSkills();
      await toDiscord(`**Skills:** ${list}`);
      return;
    }
    if (/^#skill\s+forget\s+\S+/i.test(lower)) {
      const name = lower.replace(/^#skill\s+forget\s+/, '').trim();
      const ok = require('./skill-engine').deleteSkill(name);
      await toDiscord(ok ? `Skill **${name}** forgotten.` : `No skill named **${name}**.`);
      return;
    }
    if (/^#skill\s+learn\s+.+/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft — cannot learn skills right now.'); return; }
      const task = content.replace(/^#skill\s+learn\s+/i, '').trim();
      await toDiscord(`Learning: *${task}*...`);
      require('./skill-engine').learnSkill(bot, task)
        .then(() => toDiscord(`Skill learned: **${task}**`))
        .catch(e => toDiscord(`Failed to learn: ${e.message}`));
      return;
    }
    if (/^#skill\s+run\s+\S+/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft — cannot run skills right now.'); return; }
      const name = content.replace(/^#skill\s+run\s+/i, '').trim();
      await toDiscord(`Running skill: **${name}**...`);
      require('./skill-engine').runSkill(bot, name)
        .then(r => toDiscord(r.success ? `Skill **${name}** done.` : `Skill **${name}** failed: ${r.error}`))
        .catch(e => toDiscord(`Error: ${e.message}`));
      return;
    }

    // ── Goal queue ───────────────────────────────────────────────────────────
    if (/^#goal\s+.+/i.test(lower)) {
      const task = content.replace(/^#goal\s+/i, '').trim();
      require('./skill-engine').queueGoal(task);
      await toDiscord(`Goal queued: *${task}*`);
      return;
    }

    // ── Trust ────────────────────────────────────────────────────────────────
    if (/^#trust\s+\S+/i.test(lower)) {
      const name = content.replace(/^#trust\s+/i, '').trim();
      require('./trust').trustPlayer(name);
      await toDiscord(`**${name}** is now trusted.`);
      return;
    }
    if (/^#untrust\s+\S+/i.test(lower)) {
      const name = content.replace(/^#untrust\s+/i, '').trim();
      require('./trust').untrustPlayer(name);
      await toDiscord(`**${name}** is no longer trusted.`);
      return;
    }
    if (/^#trusted$/i.test(lower)) {
      const list = require('./trust').listTrusted();
      await toDiscord(`**Trusted players:** ${list.length ? list.join(', ') : 'none'}`);
      return;
    }

    // ── Server switching ─────────────────────────────────────────────────────
    if (/^#server\s+list$/i.test(lower)) {
      const servers = loadServers();
      const names   = Object.keys(servers);
      if (!names.length) { await toDiscord('No server profiles in servers.json.'); return; }
      const current = getActiveServerName();
      const lines = names.map(n => {
        const s = servers[n];
        return `**${n}**${n === current ? ' *(current)*' : ''}: \`${s.host}:${s.port}\` v${s.version}${s.description ? ' — ' + s.description : ''}`;
      });
      await toDiscord('**Server profiles:**\n' + lines.join('\n'));
      return;
    }
    if (/^#server\s+switch\s+\S+/i.test(lower)) {
      const name = lower.replace(/^#server\s+switch\s+/, '').trim();
      try {
        setActiveServer(name);
        const sc = getServerConfig();
        await toDiscord(`Switching to **${name}** (\`${sc.host}:${sc.port}\`) — reconnecting...`);
        if (bot) {
          state.pendingServerSwitch = { targetName: name, attempt: 0, replyTarget: 'discord' };
          setTimeout(() => bot.quit('server switch'), 500);
        } else await toDiscord('(Nilo is offline — will connect to the new server on next start.)');
      } catch (e) {
        await toDiscord(`Error: ${e.message}`);
      }
      return;
    }
    if (/^#server\s+current$/i.test(lower)) {
      const sc = getServerConfig();
      await toDiscord(`Current server: **${getActiveServerName()}** (\`${sc.host}:${sc.port}\` v${sc.version})`);
      return;
    }
    if (/^#server\s+save\s+\S+/i.test(lower)) {
      const name = lower.replace(/^#server\s+save\s+/, '').trim();
      const sc   = getServerConfig();
      addServer(name, { host: sc.host, port: sc.port, version: sc.version, auth: sc.auth, description: '' });
      await toDiscord(`Saved current server (\`${sc.host}:${sc.port}\`) as **${name}**.`);
      return;
    }
    if (/^#server\s+add\s+\S+\s+\S+/i.test(lower)) {
      const m = content.match(/^#server\s+add\s+(\S+)\s+(\S+)(?:\s+(\d+))?/i);
      if (!m) { await toDiscord('Usage: `#server add <name> <host> [port]`'); return; }
      const [, name, host, portStr] = m;
      const port = portStr ? parseInt(portStr) : 25565;
      const sc   = getServerConfig();
      addServer(name, { host, port, version: sc.version, auth: sc.auth, description: '' });
      try {
        setActiveServer(name);
        await toDiscord(`Added **${name}** (\`${host}:${port}\`) and connecting...`);
        if (bot) {
          state.pendingServerSwitch = { targetName: name, attempt: 0, replyTarget: 'discord' };
          setTimeout(() => bot.quit('server switch'), 500);
        } else await toDiscord('(Nilo is offline — will connect to **' + name + '** on next start.)');
      } catch (e) {
        await toDiscord(`Error: ${e.message}`);
      }
      return;
    }

    // ── Behavior ─────────────────────────────────────────────────────────────
    if (/^#behavior\s+clear$/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft.'); return; }
      require('./behavior').clearBehavior(bot);
      await toDiscord('Behavior cleared.');
      return;
    }
    if (/^#behavior\s+\S+/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft.'); return; }
      const mode = lower.replace(/^#behavior\s+/, '').trim();
      require('./behavior').setBehavior(bot, mode, MASTER);
      await toDiscord(`Behavior set to **${mode}**.`);
      return;
    }

    // A prefix is REQUIRED to reach the command pipeline — matches the
    // in-game rule that no command ever fires without one. Without it, this
    // falls straight through to Letta/search below as plain chat. Two forms
    // accepted: "#nilo <text>" (Discord's own long-standing convention) or a
    // bare "#" (matches in-game chat exactly — "#step 2 forward" etc.).
    let hadPrefix, cleaned;
    if (/^#nilo\b/i.test(content)) {
      hadPrefix = true;
      cleaned = content.replace(/^#nilo\s*/i, '').trim();
    } else if (/^#/.test(content)) {
      hadPrefix = true;
      cleaned = content.slice(1).trim();
    } else {
      hadPrefix = false;
      cleaned = content.trim();
    }
    if (!cleaned) return;

    console.log(`[DISCORD${bot ? '→MC' : ' OFFLINE'}] ${message.author.username}: ${cleaned}`);

    // Try natural command pipeline only when in-game and prefixed
    if (bot && hadPrefix) {
      const { handleNaturalCommand } = require('./commands');
      let acted = false;
      try { acted = await handleNaturalCommand(bot, cleaned.toLowerCase(), cleaned, undefined, { prefixed: true }); }
      catch (err) { console.error('[DISCORD] handleNaturalCommand error:', err.message); }

      if (acted) {
        state.lastInteractionTime = Date.now();
        return;
      }
    }

    // Internet on/off + search work even when Nilo is offline in-game —
    // web access doesn't need a Minecraft connection.
    if (!bot) {
      const { IS_INTERNET_ON, IS_INTERNET_OFF, SEARCH_RE, runSearch } = require('./commands/internet');
      const lowerCleaned = cleaned.toLowerCase();

      if (IS_INTERNET_ON(lowerCleaned)) {
        state.internetEnabled = true;
        await toDiscord("Internet on — I'll search the web on my own when it's useful.");
        return;
      }
      if (IS_INTERNET_OFF(lowerCleaned)) {
        state.internetEnabled = false;
        await toDiscord('Internet off.');
        return;
      }
      const m = cleaned.match(SEARCH_RE);
      if (m) {
        const query = m[1].trim();
        if (!state.internetEnabled) {
          await toDiscord('Internet access is off — say "internet on" first.');
          return;
        }
        if (query) {
          await toDiscord(`Searching: ${query}...`);
          try {
            const result = await runSearch(query);
            await toDiscord(result?.text ? `**NILO:** ${result.text}` : "Nothing useful came back.");
          } catch (err) {
            console.error('[DISCORD] search error:', err.message);
            await toDiscord("Couldn't reach the search engine.");
          }
          state.lastInteractionTime = Date.now();
          return;
        }
      }
    }

    // Letta — works whether online or offline
    try {
      const { detectLanguage }          = require('./lang');
      const { queryLetta, parseAction } = require('./letta');
      const { sessionHintFor }          = require('./monitor');
      const { getSearchContext }        = require('./websearch');

      const lang = detectLanguage(cleaned);
      const searchCtx = await getSearchContext(cleaned);
      const searchPrefix = searchCtx ? `${searchCtx}\n\n` : '';
      let ctx;

      if (bot) {
        const { getInventorySummary } = require('./items');
        const { dispatchAction }      = require('./actions');
        const inv  = getInventorySummary(bot);
        const held = bot.heldItem ? bot.heldItem.name : 'nothing';
        const actionHint = `[Available actions — if the message implies one, append [ACTION: name]: follow, stay, sit, stop, come, closer, unstuck, dance, fish, stop_fish, bow, shoot_target, tunnel, build_house, sleep, wander, attack, defensive, passive, explore, stop_explore, collect_grave, wave, spin, jump, ensure_tools]`;
        ctx = `${sessionHintFor(MASTER)}${searchPrefix}${replyContext}${speakerName} says (via Discord): ${cleaned}\n[inventory: ${inv}, holding: ${held}]\n${actionHint}`;

        const raw = await queryLetta(ctx);
        const { text, action } = parseAction(raw);
        state.lastInteractionTime = Date.now();
        if (text)   bot.chat(text);  // monkey-patch handles Discord, skips in-game (discordContext=true)
        if (action) dispatchAction(bot, action, MASTER);
      } else {
        ctx = `${sessionHintFor(MASTER)}${searchPrefix}${replyContext}${speakerName} says (via Discord): ${cleaned}`;

        const raw = await queryLetta(ctx);
        const { text } = parseAction(raw);
        state.lastInteractionTime = Date.now();
        if (text) await toDiscord(`**NILO:** ${text}`);
      }
    } catch (err) {
      console.error('[DISCORD] Letta error:', err.message);
      await toDiscord('My thoughts are unclear right now.');
    }
    return;
  }

  // Non-master users: only basic read-only commands
  if (lower === '#help') {
    await toDiscord(
      '**NILO Bridge commands**\n' +
      '`#status` — show current bot status\n' +
      '`#skills` — list learned skills\n' +
      '_Full control requires MASTER authorization._'
    );
  }
}


// ── Discord client startup (call once at boot, before Minecraft connects) ─────

function startDiscord() {
  if (!isEnabled()) {
    console.log('[DISCORD] Bridge disabled — set DISCORD_TOKEN and DISCORD_CHANNEL_ID to enable.');
    return;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  discordClient.once('ready', async () => {
    console.log(`[DISCORD] Logged in as ${discordClient.user.tag}`);
    try {
      bridgeChannel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
      const now = new Date().toLocaleString('en-GB', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      lastAwakeNoticeTime = Date.now();
      await toDiscord(`NILO is awake (${now}). Type \`#status\` to check in.`);
    } catch (err) {
      console.error('[DISCORD] Could not fetch bridge channel:', err.message);
    }
  });

  discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channelId !== DISCORD_CHANNEL_ID) return;
    await handleDiscordMessage(message);
  });

  discordClient.on('error', (err) => console.error('[DISCORD] Client error:', err.message));

  discordClient.login(DISCORD_TOKEN).catch(err => {
    console.error('[DISCORD] Login failed:', err.message);
  });

  console.log('[DISCORD] Client starting...');
}

// ── Attach to a Minecraft bot once it connects ────────────────────────────────

function attachBot(bot) {
  _botRef = bot;
  // Skip this notice if we just posted "NILO is awake" — both firing back to
  // back on a normal startup is redundant noise in the channel.
  if (Date.now() - lastAwakeNoticeTime > JOIN_NOTICE_SUPPRESS_MS) {
    toDiscord('**NILO joined Minecraft.** Type `#status` to check in.');
  }

  // Wrap bot.chat so a reply only ever goes back to the channel that
  // triggered it — Discord, the terminal CLI, and real in-game chat are kept
  // fully separate, never mirrored into each other:
  //   discordContext=true  → Discord only (message came from Discord)
  //   discordContext=false → in-game/CLI only (real chat + CLI forward — see
  //                          nilo.js's own bot.chat patch — never posted to Discord)
  const origChat = bot.chat.bind(bot);
  bot.chat = function(text) {
    if (state.discordContext) {
      // Any slash-command (skin, tp, execute, login, etc.) is a server
      // instruction, not something Nilo "said" — never leak it to Discord.
      if (!/^\//.test(text)) toDiscord(`**NILO:** ${text}`);
      return;
    }
    origChat(text);
  };

  // Other players chat
  // Deaths and respawns
  bot.on('death', () => {
    toDiscord('**NILO died.** Respawning...');
  });

  bot.on('spawn', () => {
    if (state.justDied) toDiscord('**NILO respawned.**');
  });

  // On disconnect — clear bot ref so offline chat still works
  bot.on('end', () => {
    toDiscord('**NILO left Minecraft.** Reconnecting in 10s... (still reachable here)');
    _botRef = null;
  });

  console.log('[DISCORD] Attached to Minecraft bot.');
}


async function stopDiscord(reason = 'stop') {
  if (!discordClient) return;
  const msg = reason === 'restart'
    ? '**NILO is restarting...** Back in a moment.'
    : '**NILO is going offline.** See you later.';
  await toDiscord(msg);
  discordClient.destroy();
}

module.exports = { startDiscord, attachBot, toDiscord, stopDiscord };
