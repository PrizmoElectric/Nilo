// pathfinder-compat.js — mineflayer-pathfinder's API surface, backed by
// @miner-org/mineflayer-baritone (AshFinder) underneath.
//
// Why this exists: the whole codebase is built around mineflayer-pathfinder's
// fire-and-forget model (setGoal(goal, dynamic) — call it again anytime to
// redirect, it just replans). AshFinder's goto(goal) is single-shot and
// promise-based; it throws if called again before stop()/completion. Rather
// than rewrite every call site's control flow, this shim reproduces the old
// surface (setGoal/goto/setMovements/.goal/.movements/.stop/.thinkingTimeout,
// plus Movements/GoalNear/GoalBlock/GoalFollow with their old constructor
// signatures) and translates it into stop()+goto() cycles underneath, with
// goal-diffing so identical repeated setGoal() calls (e.g. every combat tick)
// don't restart pathfinding from scratch.

const { loader: injectAshFinder, goals: newGoals } = require('@miner-org/mineflayer-baritone');
const { Vec3 } = require('vec3');

// ── Goals — old (x, y, z, ...) constructor signatures wrapping the new
// Vec3-based ones ──────────────────────────────────────────────────────────

class GoalNear extends newGoals.GoalNear {
  constructor(x, y, z, range = 1) {
    super(new Vec3(x, y, z), range);
  }
}

class GoalBlock extends newGoals.GoalExact {
  constructor(x, y, z) {
    super(new Vec3(x, y, z));
  }
}

// The library has no public dynamic "follow" goal (GoalFollowEntity exists in
// its source but isn't exported) — its own followEntity() helper works around
// this by just reconstructing a plain GoalNear at the entity's current
// position and reissuing goto() every 500ms. Nilo's own follow loops
// (movement.js startFollow, clones.js, mirror.js) already reconstruct + call
// setGoal() on their own interval the same way, so a static snapshot here is
// sufficient — same shape as GoalNear, just sourced from an entity.
class GoalFollow extends newGoals.GoalNear {
  constructor(entity, range = 2) {
    super(entity.position, range);
    this.entity = entity;
  }
}

function goalsEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.constructor !== b.constructor) return false;
  if (a.entity && b.entity) return a.entity === b.entity && a.distance === b.distance;
  const pa = a.getPosition(), pb = b.getPosition();
  return pa.x === pb.x && pa.y === pb.y && pa.z === pb.z && a.distance === b.distance;
}

// ── Movements — old mutable config object, translated into AshFinder's
// config on setMovements(). openable/blocksToAvoid are ID-keyed Sets whose
// .add() also resolves the block name and pushes it into the live AshFinder
// config, since some call sites mutate movements.openable AFTER setMovements()
// has already been called (runtime-learned doors). ──────────────────────────

function makeIdNameSyncSet(bot, getTargetArray) {
  return new Proxy(new Set(), {
    get(target, prop, receiver) {
      if (prop === 'add') {
        return (id) => {
          target.add(id);
          const block = bot.registry.blocks[id] || bot.registry.blocksByName[
            Object.keys(bot.registry.blocksByName).find(n => bot.registry.blocksByName[n].id === id)
          ];
          const name = block?.name;
          if (name) {
            const arr = getTargetArray();
            if (arr && !arr.includes(name)) arr.push(name);
          }
          return receiver;
        };
      }
      const val = Reflect.get(target, prop);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

class Movements {
  constructor(bot) {
    this._bot = bot;
    this.canDig = false;
    this.canOpenDoors = true;
    // fences: mineflayer-pathfinder-specific false-positive workaround (modded
    // stone/brick blocks misclassified as impassable via a precomputed shape
    // Set). AshFinder computes solidity per-block on the fly (isSolid/getMaxY)
    // instead of a precomputed Set, so this bug class doesn't exist here —
    // kept as an inert Set so the existing cleanup loop in movement.js has
    // something safe to add/delete from.
    this.fences = new Set();
    this.openable = makeIdNameSyncSet(bot, () => bot.ashfinder?.config.interactableBlocks);
    this.blocksToAvoid = makeIdNameSyncSet(bot, () => bot.ashfinder?.config.blocksToStayAway);
  }
}

// ── Plugin loader ────────────────────────────────────────────────────────────

function pathfinder(bot) {
  injectAshFinder(bot, {});
  const af = bot.ashfinder;

  let currentMovements = null;

  bot.pathfinder = {
    get thinkingTimeout() { return af.config.thinkTimeout; },
    set thinkingTimeout(v) { af.config.thinkTimeout = v; },

    get goal() { return af.currentGoal; },
    get movements() { return currentMovements; },

    setMovements(movements) {
      currentMovements = movements;
      af.config.breakBlocks = !!movements.canDig;
      // Materialize whatever was added to openable/blocksToAvoid before this
      // call (the Proxy already pushed names in live, this is a no-op unless
      // movements was built without going through the shim's Movements class).
    },

    setGoal(goal, _dynamic = false) {
      if (goal == null) {
        if (!af.stopped) af.stop();
        return;
      }
      if (goalsEqual(af.currentGoal, goal)) return; // avoid replanning an unchanged goal every tick
      if (!af.stopped) af.stop();
      af.goto(goal).then((r) => {
        if (r.status === 'failed') {
          bot.emit('path_update', { status: 'noPath', visitedNodes: 0 });
        }
      }).catch(() => {});
    },

    async goto(goal) {
      if (!af.stopped) af.stop();
      const r = await af.goto(goal);
      if (r.status === 'failed') throw r.error || new Error('No path found');
    },

    stop() {
      if (!af.stopped) af.stop();
    },
  };
}

module.exports = {
  pathfinder,
  Movements,
  goals: { GoalBlock, GoalNear, GoalFollow },
};
