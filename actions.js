// actions.js — LLM action dispatch and raw command runner

const state = require('./state');
const { setBehavior } = require('./behavior');
const { createMovements, startFollow, tryUnstuck } = require('./movement');
const { startAttack, startBowMode, shootAtGazeTarget } = require('./combat');
const { startTunnel } = require('./tunnel');
const { collectGrave, startFishing, buildSimpleHouse, startDance, sleepInBed } = require('./activities');
const { ensureTools } = require('./crafting');
const { goals: { GoalNear } } = require('mineflayer-pathfinder');

// ── Action dispatch ───────────────────────────────────────────────────────────

function dispatchAction(bot, action, username) {
  console.log(`[NILO] LLM-dispatched action: ${action}`);
  switch (action) {
    case 'follow':
      bot.setControlState('sneak', false);
      startFollow(bot, username, 2);
      break;
    case 'stay':
    case 'stop':
      setBehavior(bot, 'idle', username);
      break;
    case 'sit':
      setBehavior(bot, 'sit', username);
      bot.setControlState('sneak', true);
      break;
    case 'come': {
      setBehavior(bot, 'idle', username);
      const t = bot.players[username]?.entity;
      if (t) {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalNear(t.position.x, t.position.y, t.position.z, 2));
      }
      break;
    }
    case 'closer':
      startFollow(bot, username, 1);
      break;
    case 'unstuck':
      tryUnstuck(bot)
        .then(ok => { if (!ok) bot.chat("Completely stuck. Can you give me a hand?"); })
        .catch(err => console.error('[NILO] Unstuck error:', err.message));
      break;
    case 'dance':
      startDance(bot);
      break;
    case 'fish':
      startFishing(bot);
      break;
    case 'stop_fish':
      if (state.behaviorMode === 'fishing') { setBehavior(bot, 'idle', username); bot.deactivateItem(); }
      break;
    case 'bow':
      startBowMode(bot);
      break;
    case 'shoot_target':
      shootAtGazeTarget(bot).catch(err => console.error('[NILO] shoot_target error:', err.message));
      break;
    case 'tunnel':
      startTunnel(bot).catch(err => console.error('[NILO] tunnel error:', err.message));
      break;
    case 'build_house':
      buildSimpleHouse(bot);
      break;
    case 'sleep':
      sleepInBed(bot);
      break;
    case 'wander':
      setBehavior(bot, 'wander', username);
      break;
    case 'attack':
      startAttack(bot, username);
      break;
    case 'defensive':
      setBehavior(bot, 'defensive', username);
      break;
    case 'passive':
      setBehavior(bot, 'passive', username);
      break;
    case 'explore':
      state.exploringEnabled = true;
      setBehavior(bot, 'idle', username);
      break;
    case 'stop_explore':
      state.exploringEnabled = false;
      setBehavior(bot, 'idle', username);
      break;
    case 'collect_grave':
      collectGrave(bot)
        .catch(err => console.error('[NILO] Grave collect error:', err.message));
      break;
    case 'wave':
      (async () => {
        bot.chat('*waves*');
        for (let i = 0; i < 6; i++) {
          bot.swingArm();
          await new Promise(r => setTimeout(r, 280));
        }
      })();
      break;
    case 'spin':
      (async () => {
        bot.chat('*spins*');
        const steps = 20;
        for (let s = 0; s < steps; s++) {
          await bot.look(bot.entity.yaw + (Math.PI * 2 / steps), bot.entity.pitch, false);
          await new Promise(r => setTimeout(r, 60));
        }
      })();
      break;
    case 'jump':
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      break;
    case 'ensure_tools':
      ensureTools(bot).catch(err => console.error('[CRAFT] ensureTools error:', err.message));
      break;
    default:
      console.warn(`[NILO] Unknown LLM action: ${action}`);
  }
}

// ── Command runner ────────────────────────────────────────────────────────────
// bot.chat('/command') in offline mode may fall back to a plain chat packet —
// the 1.20.1 server does not execute a chat_message starting with '/' as a command.
// Write the chat_command packet directly so it always goes to the right handler.

function runCommand(bot, command) {
  const cmd = command.startsWith('/') ? command.slice(1) : command;
  try {
    bot._client.write('chat_command', {
      command:            cmd,
      timestamp:          BigInt(Date.now()),
      salt:               0n,
      argumentSignatures: [],
      messageCount:       0,
      acknowledged:       Buffer.alloc(3, 0),
    });
    console.log(`[NILO] Sent chat_command: ${cmd}`);
  } catch (err) {
    // Fallback: let mineflayer try its own routing
    console.warn(`[NILO] chat_command write failed (${err.message}), falling back to bot.chat`);
    bot.chat(`/${cmd}`);
  }
}

module.exports = { dispatchAction, runCommand };
