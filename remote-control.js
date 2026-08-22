// remote-control.js — polls Solsai /bot-control-state and drives the bot.
// Entered by BotSneakScreen (Shift+right-click a bot in prizmo-system).
// Exits automatically when no control packet arrives for 500 ms (timeout on Solsai side).
//
// Also polls /terminal-command-state for commands typed into prizmo-system's
// TerminalScreen and runs them through the normal chat-command parser as MASTER —
// same power as chat commands, but invisible to other players.

const http = require('http');
const { BOT_USERNAME, MASTER } = require('./config');
const { handleNaturalCommand } = require('./commands');
const state = require('./state');

const HOST    = 'localhost';
const PORT    = 8080;
const POLL_MS = 100;

let pollInterval         = null;
let terminalPollInterval = null;
let inControl    = false;
let lastYaw      = null;
let lastPitch    = null;

function pollControlState() {
    return new Promise(resolve => {
        const req = http.get(
            { host: HOST, port: PORT, path: `/bot-control-state?player=${encodeURIComponent(BOT_USERNAME)}`, timeout: 150 },
            res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve(null); }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function pollTerminalCommand() {
    return new Promise(resolve => {
        const req = http.get(
            { host: HOST, port: PORT, path: `/terminal-command-state?player=${encodeURIComponent(BOT_USERNAME)}`, timeout: 150 },
            res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve(null); }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function releaseAll(bot) {
    try {
        bot.clearControlStates();
        if (state.isSneaking) bot.setControlState('sneak', true);
    } catch (_) {
        // bot may already be disconnected (e.g. called from the 'end' handler)
    }
    lastYaw   = null;
    lastPitch = null;
}

function applyControlState(bot, cs) {
    bot.setControlState('forward', !!cs.forward);
    bot.setControlState('back',    !!cs.back);
    bot.setControlState('left',    !!cs.left);
    bot.setControlState('right',   !!cs.right);
    bot.setControlState('jump',    !!cs.jump);
    bot.setControlState('sneak',   !!cs.sneak);

    // Look: accumulate yaw/pitch delta from last received values
    if (lastYaw !== null) {
        const dy = cs.yaw   - lastYaw;
        const dp = cs.pitch - lastPitch;
        if (Math.abs(dy) > 0.01 || Math.abs(dp) > 0.01) {
            const newYaw   = bot.entity.yaw   + dy * Math.PI / 180;
            const newPitch = Math.max(-Math.PI / 2,
                             Math.min( Math.PI / 2,
                                       bot.entity.pitch + dp * Math.PI / 180));
            bot.look(newYaw, newPitch, false);
        }
    }
    lastYaw   = cs.yaw;
    lastPitch = cs.pitch;

    // Attack: swing arm (server handles hit detection for entities in range/view)
    if (cs.attack) bot.swingArm();

    // Use: activate held item
    if (cs.use) bot.activateItem();
}

function startRemoteControl(bot) {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
        const cs = await pollControlState();

        if (!cs || !cs.active) {
            if (inControl) {
                inControl = false;
                releaseAll(bot);
                console.log('[REMOTE] Control released');
            }
            return;
        }

        if (!inControl) {
            inControl = true;
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            console.log('[REMOTE] Control acquired');
        }

        if (!bot.entity) return;
        applyControlState(bot, cs);
    }, POLL_MS);

    // Independent of remote-control state — runs on the same 100ms tick.
    terminalPollInterval = setInterval(async () => {
        const tc = await pollTerminalCommand();
        if (!tc || !tc.command) return;
        const lower = tc.command.toLowerCase();
        try {
            await handleNaturalCommand(bot, lower, tc.command, MASTER, { prefixed: true });
        } catch (err) {
            console.error('[TERMINAL] command error:', err.message);
        }
    }, POLL_MS);
}

function stopRemoteControl(bot) {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (terminalPollInterval) { clearInterval(terminalPollInterval); terminalPollInterval = null; }
    if (inControl && bot) { releaseAll(bot); inControl = false; }
}

module.exports = { startRemoteControl, stopRemoteControl };
