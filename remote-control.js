// remote-control.js — polls Solsai /bot-control-state and drives the bot.
// Entered by BotSneakScreen (Shift+right-click a bot in prizmo-system).
// Exits automatically when no control packet arrives for 500 ms (timeout on Solsai side).
//
// Also polls /terminal-command-state for commands typed into prizmo-system's
// TerminalScreen and runs them through the normal chat-command parser as MASTER —
// same power as chat commands, but invisible to other players.

const http = require('http');
const { Vec3 } = require('vec3');
const { BOT_USERNAME, MASTER, getSolsaiBase } = require('./config');
const { handleNaturalCommand } = require('./commands');
const state = require('./state');

const POLL_MS = 100;

// Standard prismarine BlockFace index → offset vector (BOTTOM,TOP,NORTH,SOUTH,WEST,EAST).
const FACE_VECTORS = [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0),
    new Vec3(0, 0, -1), new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
];

let pollInterval         = null;
let terminalPollInterval = null;
let inControl    = false;
let lastYaw      = null;
let lastPitch    = null;
let lastUse      = false; // edge-detect cs.use so a held right-click doesn't spam-place every 100ms
let miningBlockKey = null; // "x,y,z" of the block currently being dug, or null — lets a held
                           // left-click keep digging the SAME block across polls without
                           // restarting, while a changed target or an early release stops it

function pollControlState() {
    return new Promise(resolve => {
        const { host, port } = getSolsaiBase();
        const req = http.get(
            { host, port, path: `/bot-control-state?player=${encodeURIComponent(BOT_USERNAME)}`, timeout: 150 },
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
        const { host, port } = getSolsaiBase();
        const req = http.get(
            { host, port, path: `/terminal-command-state?player=${encodeURIComponent(BOT_USERNAME)}`, timeout: 150 },
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
        if (miningBlockKey) bot.stopDigging();
    } catch (_) {
        // bot may already be disconnected (e.g. called from the 'end' handler)
    }
    lastYaw   = null;
    lastPitch = null;
    miningBlockKey = null;
}

function applyControlState(bot, cs) {
    bot.setControlState('forward', !!cs.forward);
    bot.setControlState('back',    !!cs.back);
    bot.setControlState('left',    !!cs.left);
    bot.setControlState('right',   !!cs.right);
    bot.setControlState('jump',    !!cs.jump);
    bot.setControlState('sneak',   !!cs.sneak);

    // Look: accumulate yaw/pitch delta from last received values.
    // cs.yaw/cs.pitch are in vanilla's raw convention (matching BotSneakScreen's degrees),
    // but bot.entity.yaw/pitch are in mineflayer's OWN convention, which is the opposite sign
    // on both axes — confirmed in mineflayer/lib/conversions.js: toNotchianPitch = -pitch,
    // toNotchianYaw = PI - yaw (a delta in vanilla terms is the negated delta in mineflayer
    // terms for both). Adding the raw delta straight onto bot.entity.yaw/pitch without
    // negating it applied every mouse move backwards on both axes — negate here instead.
    if (lastYaw !== null) {
        const dy = cs.yaw   - lastYaw;
        const dp = cs.pitch - lastPitch;
        if (Math.abs(dy) > 0.01 || Math.abs(dp) > 0.01) {
            const newYaw   = bot.entity.yaw   - dy * Math.PI / 180;
            const newPitch = Math.max(-Math.PI / 2,
                             Math.min( Math.PI / 2,
                                       bot.entity.pitch - dp * Math.PI / 180));
            bot.look(newYaw, newPitch, false);
        }
    }
    lastYaw   = cs.yaw;
    lastPitch = cs.pitch;

    // Attack/mine: was bot.swingArm() only — a purely cosmetic animation, no actual damage or
    // block breaking. Real melee needs bot.attack(entity); real mining needs bot.dig(block),
    // which is async and must be started/stopped explicitly rather than fired every tick — both
    // already swing the arm internally, so there's no separate swingArm() call needed anymore.
    if (cs.attack) {
        const entity = bot.entityAtCursor(4);
        if (entity) {
            if (miningBlockKey) { bot.stopDigging(); miningBlockKey = null; }
            bot.attack(entity);
        } else {
            const block = bot.blockAtCursor(5);
            if (block && block.diggable) {
                const key = `${block.position.x},${block.position.y},${block.position.z}`;
                if (key !== miningBlockKey) {
                    if (miningBlockKey) bot.stopDigging();
                    miningBlockKey = key;
                    bot.dig(block).catch(() => {}).finally(() => {
                        if (miningBlockKey === key) miningBlockKey = null;
                    });
                }
            } else if (miningBlockKey) {
                bot.stopDigging();
                miningBlockKey = null;
            }
        }
    } else if (miningBlockKey) {
        // Released early — matches vanilla, releasing LMB before a block breaks cancels it.
        bot.stopDigging();
        miningBlockKey = null;
    }

    // Use: right-click. Edge-triggered on cs.use's rising edge only — BotSneakScreen sends
    // the raw held-down state every ~100ms poll, and placeBlock() below both throws on
    // failure (no valid target) and would otherwise attempt a fresh placement on every
    // single poll for as long as RMB stays held, same as holding a real mouse button down
    // doesn't spam-place blocks in vanilla either.
    // A block item tries to place via a cursor raycast (bot.blockAtCursor); anything else
    // (food, bow, potion, bucket, etc.) just activates normally, same as before.
    if (cs.use && !lastUse) {
        const held = bot.heldItem;
        if (held && bot.registry.blocksByName[held.name]) {
            const target = bot.blockAtCursor(5);
            if (target) {
                bot.placeBlock(target, FACE_VECTORS[target.face]).catch(() => {});
            }
        } else {
            bot.activateItem();
        }
    }
    lastUse = cs.use;

    // Held slot: one-shot request from a number key (1-9) in BotSneakScreen.
    // -1 (or absent) means "no change this tick" — Solsai's ControlState is
    // replaced wholesale every send, so this only appears for a single ~100ms
    // poll window right after the key press.
    if (Number.isInteger(cs.heldSlot) && cs.heldSlot >= 0 && cs.heldSlot <= 8) {
        bot.setQuickBarSlot(cs.heldSlot);
    }
}

function startRemoteControl(bot) {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
        const cs = await pollControlState();

        if (!cs || !cs.active) {
            if (inControl) {
                inControl = false;
                state.possessed = false;
                releaseAll(bot);
                console.log('[REMOTE] Control released');
            }
            return;
        }

        if (!inControl) {
            inControl = true;
            state.possessed = true;
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
    state.possessed = false;
}

module.exports = { startRemoteControl, stopRemoteControl };
