// discord-bridge.js — two-way bridge between Nilo's Minecraft chat and Discord
//
// Discord → Minecraft:
//   Messages in the bridge channel from MASTER's Discord account are forwarded
//   to handleNaturalCommand (same pipeline as in-game chat). Other authorized
//   users get basic command access (!follow, !stay, !status, etc.).
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
const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_MASTER_ID, BOT_USERNAME, MASTER } = require('./config');

let discordClient  = null;
let bridgeChannel  = null;
let _botRef        = null;  // set on init

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

function buildStatusEmbed(bot) {
  if (!bot) return 'Nilo is offline.';
  const pos    = bot.entity?.position;
  const posStr = pos ? `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : 'unknown';
  const health = bot.health != null ? `${Math.round(bot.health)}/20` : 'unknown';
  const food   = bot.food   != null ? `${bot.food}/20` : 'unknown';
  const mode   = state.behaviorMode || 'idle';
  const skills = (() => { try { return require('./skill-engine').skillCount(); } catch(_) { return '?'; } })();
  const auto   = state.autonomousSkillsEnabled ? 'ON' : 'OFF';

  return [
    '```',
    `NILO STATUS`,
    `Position : ${posStr}`,
    `Health   : ${health}    Food: ${food}`,
    `Mode     : ${mode}`,
    `Skills   : ${skills} learned    Autonomous: ${auto}`,
    '```',
  ].join('\n');
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
  const content  = message.content.trim();
  const lower    = content.toLowerCase();

  // !status — anyone in the channel can check
  if (lower === '!status' || lower === '!nilo status') {
    await toDiscord(buildStatusEmbed(bot));
    return;
  }

  // !skills — list learned skills
  if (lower === '!skills' || lower === '!nilo skills') {
    const list = require('./skill-engine').listSkills();
    await toDiscord(`**Skills:** ${list}`);
    return;
  }

  // MASTER-only direct commands (no Letta, instant response)
  if (isMaster) {
    // ── Help ─────────────────────────────────────────────────────────────────
    if (lower === '!help') {
      await toDiscord(
        '**NILO Master commands**\n' +
        '`!autonomous on/off` — toggle autonomous behavior\n' +
        '`!skill list` — list skills\n' +
        '`!skill learn <task>` — learn a new skill\n' +
        '`!skill run <name>` — run a skill\n' +
        '`!skill forget <name>` — delete a skill\n' +
        '`!goal <task>` — queue a goal\n' +
        '`!trust <player>` / `!untrust <player>` — manage trust\n' +
        '`!trusted` — list trusted players\n' +
        '`!behavior <mode>` / `!behavior clear` — set behavior\n' +
        '`!status` / `!skills` — status & skill list\n' +
        '_Or just talk naturally — Nilo understands you._'
      );
      return;
    }

    // ── Autonomous ──────────────────────────────────────────────────────────
    if (/^!autonomous\s+(on|off)$/i.test(lower)) {
      state.autonomousSkillsEnabled = /on/i.test(lower);
      await toDiscord(`Autonomous mode: **${state.autonomousSkillsEnabled ? 'ON' : 'OFF'}**`);
      return;
    }

    // ── Skills ───────────────────────────────────────────────────────────────
    if (/^!skill\s+list$/i.test(lower)) {
      const list = require('./skill-engine').listSkills();
      await toDiscord(`**Skills:** ${list}`);
      return;
    }
    if (/^!skill\s+forget\s+\S+/i.test(lower)) {
      const name = lower.replace(/^!skill\s+forget\s+/, '').trim();
      const ok = require('./skill-engine').deleteSkill(name);
      await toDiscord(ok ? `Skill **${name}** forgotten.` : `No skill named **${name}**.`);
      return;
    }
    if (/^!skill\s+learn\s+.+/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft — cannot learn skills right now.'); return; }
      const task = content.replace(/^!skill\s+learn\s+/i, '').trim();
      await toDiscord(`Learning: *${task}*...`);
      require('./skill-engine').learnSkill(bot, task)
        .then(() => toDiscord(`Skill learned: **${task}**`))
        .catch(e => toDiscord(`Failed to learn: ${e.message}`));
      return;
    }
    if (/^!skill\s+run\s+\S+/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft — cannot run skills right now.'); return; }
      const name = content.replace(/^!skill\s+run\s+/i, '').trim();
      await toDiscord(`Running skill: **${name}**...`);
      require('./skill-engine').runSkill(bot, name)
        .then(r => toDiscord(r.success ? `Skill **${name}** done.` : `Skill **${name}** failed: ${r.error}`))
        .catch(e => toDiscord(`Error: ${e.message}`));
      return;
    }

    // ── Goal queue ───────────────────────────────────────────────────────────
    if (/^!goal\s+.+/i.test(lower)) {
      const task = content.replace(/^!goal\s+/i, '').trim();
      require('./skill-engine').queueGoal(task);
      await toDiscord(`Goal queued: *${task}*`);
      return;
    }

    // ── Trust ────────────────────────────────────────────────────────────────
    if (/^!trust\s+\S+/i.test(lower)) {
      const name = content.replace(/^!trust\s+/i, '').trim();
      require('./trust').trustPlayer(name);
      await toDiscord(`**${name}** is now trusted.`);
      return;
    }
    if (/^!untrust\s+\S+/i.test(lower)) {
      const name = content.replace(/^!untrust\s+/i, '').trim();
      require('./trust').untrustPlayer(name);
      await toDiscord(`**${name}** is no longer trusted.`);
      return;
    }
    if (/^!trusted$/i.test(lower)) {
      const list = require('./trust').listTrusted();
      await toDiscord(`**Trusted players:** ${list.length ? list.join(', ') : 'none'}`);
      return;
    }

    // ── Behavior ─────────────────────────────────────────────────────────────
    if (/^!behavior\s+clear$/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft.'); return; }
      require('./behavior').clearBehavior(bot);
      await toDiscord('Behavior cleared.');
      return;
    }
    if (/^!behavior\s+\S+/i.test(lower)) {
      if (!bot) { await toDiscord('Not in Minecraft.'); return; }
      const mode = lower.replace(/^!behavior\s+/, '').trim();
      require('./behavior').setBehavior(bot, mode, MASTER);
      await toDiscord(`Behavior set to **${mode}**.`);
      return;
    }

    // ── Prefix !nilo is optional from Discord — fall through to NL pipeline ──
    const cleaned = content.replace(/^!nilo\s*/i, '').trim();
    if (!cleaned) return;

    console.log(`[DISCORD${bot ? '→MC' : ' OFFLINE'}] ${message.author.username}: ${cleaned}`);

    // Try natural command pipeline only when in-game
    if (bot) {
      const { handleNaturalCommand } = require('./commands');
      let acted = false;
      try { acted = await handleNaturalCommand(bot, cleaned.toLowerCase(), cleaned); }
      catch (err) { console.error('[DISCORD] handleNaturalCommand error:', err.message); }

      if (acted) {
        state.lastInteractionTime = Date.now();
        return;
      }
    }

    // Letta — works whether online or offline
    try {
      const { detectLanguage }          = require('./lang');
      const { queryLetta, parseAction } = require('./letta');
      const { sessionHintFor }          = require('./monitor');

      const lang = detectLanguage(cleaned);
      let ctx;

      if (bot) {
        const { getInventorySummary } = require('./items');
        const { dispatchAction }      = require('./actions');
        const inv  = getInventorySummary(bot);
        const held = bot.heldItem ? bot.heldItem.name : 'nothing';
        const actionHint = `[Available actions — if the message implies one, append [ACTION: name]: follow, stay, sit, stop, come, closer, unstuck, dance, fish, stop_fish, bow, shoot_target, tunnel, build_house, sleep, wander, attack, defensive, passive, explore, stop_explore, collect_grave, wave, spin, jump, ensure_tools]`;
        ctx = `${sessionHintFor(MASTER)}${MASTER} says (via Discord): ${cleaned}\n[My inventory: ${inv}. Holding: ${held}. Respond in: ${lang}]\n${actionHint}`;

        const raw = await queryLetta(ctx);
        const { text, action } = parseAction(raw);
        state.lastInteractionTime = Date.now();
        if (text)   bot.chat(text);  // monkey-patch handles Discord, skips in-game (discordContext=true)
        if (action) dispatchAction(bot, action, MASTER);
      } else {
        ctx = `${sessionHintFor(MASTER)}${MASTER} says (via Discord, while I'm not in Minecraft): ${cleaned}\n[I am currently offline — not connected to any server. Respond in: ${lang}]`;

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
  if (lower === '!help') {
    await toDiscord(
      '**NILO Bridge commands**\n' +
      '`!status` — show current bot status\n' +
      '`!skills` — list learned skills\n' +
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
      await toDiscord(`NILO is awake. Type \`!status\` to check in.`);
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
  toDiscord('**NILO joined Minecraft.** Type `!status` to check in.');

  // Wrap bot.chat so responses go to the right place:
  //   discordContext=false → in-game only, then mirror to Discord
  //   discordContext=true  → Discord only (message came from Discord, don't echo back in-game)
  const origChat = bot.chat.bind(bot);
  bot.chat = function(text) {
    if (!state.discordContext) origChat(text);
    if (/^\/(login|register)\b/i.test(text)) return;
    toDiscord(`**NILO:** ${text}`);
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

// ── Legacy alias — kept so any existing callers don't break ──────────────────
function initDiscord(bot) {
  if (!discordClient) startDiscord();
  // attachBot will be called by nilo.js on login, but support old call-style too
  attachBot(bot);
}

// ── Manual post helper (usable from other modules) ───────────────────────────
// e.g. toDiscord('Farm run complete.') from activities.js

async function stopDiscord(reason = 'stop') {
  if (!discordClient) return;
  const msg = reason === 'restart'
    ? '**NILO is restarting...** Back in a moment.'
    : '**NILO is going offline.** See you later.';
  await toDiscord(msg);
  discordClient.destroy();
}

module.exports = { startDiscord, attachBot, initDiscord, toDiscord, stopDiscord };
