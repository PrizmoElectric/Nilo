// gaze.js — on-demand player gaze raycast helper
//
// Usage:
//   const { getPlayerGazeTarget } = require('./gaze');
//   const { block, entity, position } = getPlayerGazeTarget(bot);
//
// Returns the first thing MASTER is looking at within maxDistance blocks.
// No polling — call it at the moment you need it.

const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;
const { MASTER } = require('./config');

const DEFAULT_RANGE = 64;

// getPlayerGazeTarget — raycasts from MASTER's eye along their look direction.
// Returns:
//   { block, entity, position }
//   block    — prismarine Block if a block was hit (and closer than any entity), else null
//   entity   — mineflayer Entity if an entity was hit first, else null
//   position — Vec3 hit point, or null if nothing in range
function getPlayerGazeTarget(bot, maxDistance = DEFAULT_RANGE) {
  const masterEntity = bot.players[MASTER]?.entity;
  if (!masterEntity?.position) return { block: null, entity: null, position: null };

  // ── Block hit ─────────────────────────────────────────────────────────────
  // bot.blockAtEntityCursor uses the same getViewDirection logic as bot.blockAtCursor
  // but accepts any entity — free to use here.
  const block = bot.blockAtEntityCursor(masterEntity, maxDistance);
  const eye   = masterEntity.position.offset(0, masterEntity.height, 0);
  const blockDist = block ? eye.distanceTo(block.intersect) : Infinity;

  // ── Entity scan ───────────────────────────────────────────────────────────
  // Direction formula mirrors mineflayer's ray_trace plugin getViewDirection.
  const { yaw, pitch } = masterEntity;
  const cosPitch = Math.cos(pitch);
  const dir = new Vec3(
    -Math.sin(yaw) * cosPitch,
     Math.sin(pitch),
    -Math.cos(yaw) * cosPitch
  ).normalize();

  // Iterator bounded to whichever is closer: the block face or maxDistance.
  const scanRange = Math.min(blockDist, maxDistance);
  const iterator  = new RaycastIterator(eye, dir, scanRange);

  const nearby = Object.values(bot.entities).filter(e =>
    e !== masterEntity && e.position.distanceTo(masterEntity.position) <= scanRange
  );

  let hitEntity  = null;
  let entityDist = Infinity;

  for (const e of nearby) {
    const w = (e.width ?? 0.6) / 2;
    const shapes = [[-w, 0, -w, w, e.height ?? 1.8, w]];
    const intersect = iterator.intersect(shapes, e.position);
    if (!intersect) continue;
    const dist = eye.distanceTo(intersect.pos);
    if (dist < entityDist) {
      hitEntity  = e;
      entityDist = dist;
    }
  }

  // Return whichever is closer along the ray
  if (hitEntity && entityDist < blockDist) {
    return { block: null, entity: hitEntity, position: eye.plus(dir.scaled(entityDist)) };
  }

  if (block) {
    return { block, entity: null, position: block.intersect };
  }

  return { block: null, entity: null, position: null };
}

module.exports = { getPlayerGazeTarget };
