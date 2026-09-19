import type { EditorState, Vec3 } from '@reality/contracts';

/**
 * M8-C/D: what the compositor is allowed to erase, and whether it may erase at all.
 *
 * Deliberately pure and deliberately here rather than in the renderer. The spatial
 * engine owns committed visibility intent (M8 "Public interfaces"), and the compositor
 * "must not maintain independent undo history" (M8-D.5) — so the erasure set is DERIVED
 * from scene state on every frame rather than accumulated. Undo restores the scene and
 * the erasure set follows automatically, because there is nothing else for it to follow.
 *
 * Everything below is measured-space geometry. An object's design pose may have moved;
 * what has to be erased is where the REAL thing still is, which is only ever the
 * measured pose.
 */

/** Why a volume is being erased. Narration and diagnostics, never behaviour. */
export type ErasureReason =
  | 'hidden'          // explicit visibility intent (M7 removalMaskIds)
  | 'removed'         // the real object is gone or is being replaced
  | 'moved'           // the design moved it; its original appearance must go
  | 'carried'         // transient, owned by the active manipulation transaction
  | 'manual';         // a box the user drew, tied to no detected object

export type ErasureVolume = {
  id: string;
  reason: ErasureReason;
  /** Base centre in room space, matching the engine's `base_center` pivot. */
  center: Vec3;
  size: Vec3;
  yaw: number;
};

/**
 * A pose has to differ by this much before its original appearance is erased.
 *
 * Under the quantisation the solver already applies, a committed pose can differ from
 * the measured one by a fraction of a millimetre without anything having moved. Erasing
 * on that would blank furniture nobody touched.
 */
export const MOVED_EPSILON_M = 0.02;
export const MOVED_EPSILON_RAD = 0.02;

function movedFrom(a: { position: readonly number[]; yaw: number }, b: { position: readonly number[]; yaw: number }) {
  const planar = Math.hypot((a.position[0] ?? 0) - (b.position[0] ?? 0), (a.position[2] ?? 0) - (b.position[2] ?? 0));
  const turned = Math.abs(((a.yaw - b.yaw + Math.PI) % (2 * Math.PI)) - Math.PI);
  return planar > MOVED_EPSILON_M || turned > MOVED_EPSILON_RAD;
}

/**
 * Every measured object whose original appearance should no longer be shown.
 *
 * Four sources, checked in priority order so one object yields one volume with the most
 * specific reason. A `carried` object is listed even though nothing is committed yet —
 * that is M8-D.2's transient preview visibility, and it disappears the moment the
 * caller stops passing a preview scene, which is what makes a cancelled drop restore
 * the original appearance with no extra bookkeeping (M8-D.3).
 */
export function erasureVolumes(
  scene: EditorState,
  options: { carriedId?: string | null } = {},
): ErasureVolume[] {
  const design = new Map(scene.design.objects.map((o) => [o.id, o]));
  const masked = new Set(scene.removalMaskIds);
  const removed = new Set(scene.removedPhysicalIds);
  const out: ErasureVolume[] = [];

  for (const measured of scene.measured.objects) {
    if (measured.state !== 'present') continue;
    const counterpart = design.get(measured.id);
    let reason: ErasureReason | null = null;
    // Most specific first. A MOVED object is also recorded in `removedPhysicalIds` —
    // the real thing is no longer an obstacle where it was scanned — so checking
    // `removed` earlier would label every move a removal and lose the distinction the
    // narration and diagnostics depend on.
    if (options.carriedId === measured.id) reason = 'carried';
    else if (masked.has(measured.id)) reason = 'hidden';
    else if (
      counterpart &&
      counterpart.state === 'present' &&
      movedFrom(
        counterpart.pose as { position: readonly number[]; yaw: number },
        measured.pose as { position: readonly number[]; yaw: number },
      )
    )
      reason = 'moved';
    else if (removed.has(measured.id) || !counterpart || counterpart.state !== 'present')
      reason = 'removed';
    if (!reason) continue;
    out.push({
      id: measured.id,
      reason,
      center: [measured.pose.position[0]!, measured.pose.position[1]!, measured.pose.position[2]!],
      size: [measured.dimensions[0]!, measured.dimensions[1]!, measured.dimensions[2]!],
      yaw: measured.pose.yaw,
    });
  }
  // Hand-placed boxes erase whatever is inside them, detected or not. This is what
  // makes a furnace, a radiator or a pile of boxes removable without a segmentation
  // model having to recognise it first.
  //
  // Only once HIDDEN. A box that has merely been placed is a marker the user is still
  // aiming; erasing it on placement would remove the thing they are looking at while
  // they size the box around it.
  for (const volume of scene.maskVolumes.filter((v) => v.hidden))
    out.push({
      id: volume.id,
      reason: 'manual',
      center: [...volume.center] as Vec3,
      size: [...volume.size] as Vec3,
      yaw: volume.yaw,
    });
  // Fixed order so two frames build the same uniform block and a diagnostic can be
  // compared across runs.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The middle of a volume, rather than the base centre the engine stores. */
function midpoint(volume: ErasureVolume): Vec3 {
  return [volume.center[0], volume.center[1] + volume.size[1] / 2, volume.center[2]];
}

/**
 * Whether a hand-drawn box and a measured object are describing the same thing.
 *
 * Tested BOTH WAYS on purpose. A box drawn around a whole bed contains the bed's
 * centre; a small box drawn on part of a long sofa does not, but its own centre is
 * inside the sofa. Either direction means the user drew that box AT that object, and
 * only a box that merely grazes a neighbour fails both.
 */
function sameThing(box: ErasureVolume, object: ErasureVolume): boolean {
  return insideVolume(midpoint(object), box) || insideVolume(midpoint(box), object);
}

/**
 * Objects whose real pixels must be PROTECTED: retained furniture the user kept.
 *
 * With one exception, and it is the whole reason hand-drawn boxes exist. Protection is
 * there so erasing one object does not take the sofa beside it — an inference about
 * something the user did not ask about. A box the user drew around a scanned bed is not
 * an inference: they drew it, at that, on purpose. Protecting the bed from it meant a
 * box over ANY object RoomPlan had detected erased nothing at all, which is the exact
 * symptom of "the mask appears and the pixels never change".
 */
export function retainedVolumes(scene: EditorState, erasing: ErasureVolume[]): ErasureVolume[] {
  const erased = new Set(erasing.map((v) => v.id));
  const drawn = erasing.filter((v) => v.reason === 'manual');
  return scene.measured.objects
    .filter((o) => o.state === 'present' && !erased.has(o.id))
    .map((o) => ({
      id: o.id,
      reason: 'removed' as const,
      center: [o.pose.position[0]!, o.pose.position[1]!, o.pose.position[2]!] as Vec3,
      size: [o.dimensions[0]!, o.dimensions[1]!, o.dimensions[2]!] as Vec3,
      yaw: o.pose.yaw,
    }))
    .filter((object) => !drawn.some((box) => sameThing(box, object)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type ErasureInputs = {
  /** A shell whose appearance is registered to this calibration, or null. */
  shell: { calibrationId: string; calibrationRevision: number; frameId: string } | null;
  atlasReady: boolean;
  /** The live bundle's own identity, or null when nothing fresh is displayed. */
  frame: { frameId: string; hasDepth: boolean; hasForeground: boolean; ageMs: number } | null;
  tracking: boolean;
  maxFrameAgeMs: number;
};

export type ErasureAvailability =
  | { available: true; degraded: string[] }
  | { available: false; reason: string };

/**
 * Whether live erasure may run this frame.
 *
 * Every refusal here leaves the camera showing the real room, which is always a correct
 * picture. The failure this guards against is the opposite: erasing against a stale
 * bundle, a shell from a different calibration, or without the depth needed to tell
 * furniture from the person standing in front of it — each of which paints a confident
 * hole in the wrong place. "Never leave a detached screen-space patch visible" (M8-F.3)
 * is only achievable if unavailability is decided BEFORE the pass runs.
 */
export function erasureAvailability(input: ErasureInputs): ErasureAvailability {
  if (!input.tracking) return { available: false, reason: 'Tracking lost.' };
  if (!input.frame) return { available: false, reason: 'No live camera frame.' };
  if (input.frame.ageMs > input.maxFrameAgeMs)
    return { available: false, reason: 'The camera frame is stale.' };
  // A SHELL IS NO LONGER REQUIRED. Without one the compositor fills from the camera
  // pixels immediately surrounding the region, which needs no worker and no
  // reconstruction. The shell is strictly better when present — it carries real
  // texture rather than an average colour — so its absence degrades rather than
  // refuses. Requiring it made erasure unavailable in every session where nobody had
  // run a reconstruction, which was most of them.
  const degraded: string[] = [];
  if (!input.shell) degraded.push('No reconstruction: filling from surrounding colour.');
  else if (input.frame.frameId !== input.shell.frameId)
    // A shell from a previous calibration is registered to a room that no longer
    // shares this coordinate frame, so sampling it would slide against the camera.
    // Ignoring it is safe; the surrounding-colour fill takes over.
    degraded.push('The reconstruction is from an earlier calibration and is being ignored.');
  else if (!input.atlasReady) degraded.push('The background texture is still loading.');
  if (!input.frame.hasDepth)
    // A HAND-DRAWN BOX NEEDS NO DEPTH. It is a known volume, so which pixels look into
    // it is a ray-box question. Depth only tells us whether something real stands in
    // FRONT of it, so without depth the region is still correct and only the
    // foreground protection is weaker. Refusing outright made erasure impossible on
    // every device that could not provide depth, and silent on the ones that could
    // not enable it. M8-B.6's stricter rule still applies to erasing SCANNED objects,
    // whose extent is an estimate rather than something the user drew.
    degraded.push('No scene depth: objects in front of a masked area may be erased too.');
  if (!input.frame.hasForeground)
    degraded.push('No person segmentation; depth alone is protecting the foreground.');
  return { available: true, degraded };
}

/**
 * The eight corners of a volume, room space. What the compositor needs to bound the
 * erasure region on screen, and what the headless scenarios check without a GPU.
 */
export function volumeCorners(volume: ErasureVolume): Vec3[] {
  const [w, h, d] = volume.size;
  const cos = Math.cos(volume.yaw);
  const sin = Math.sin(volume.yaw);
  const corners: Vec3[] = [];
  for (const sx of [-0.5, 0.5])
    for (const sy of [0, 1])
      for (const sz of [-0.5, 0.5]) {
        const lx = sx * w;
        const lz = sz * d;
        corners.push([
          volume.center[0] + lx * cos - lz * sin,
          volume.center[1] + sy * h,
          volume.center[2] + lx * sin + lz * cos,
        ]);
      }
  return corners;
}

/** True when a room-space point is inside the volume, with an optional skin. */
export function insideVolume(point: Vec3, volume: ErasureVolume, skin = 0): boolean {
  const dx = point[0] - volume.center[0];
  const dz = point[2] - volume.center[2];
  const cos = Math.cos(-volume.yaw);
  const sin = Math.sin(-volume.yaw);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const ly = point[1] - volume.center[1];
  return (
    Math.abs(lx) <= volume.size[0] / 2 + skin &&
    Math.abs(lz) <= volume.size[2] / 2 + skin &&
    ly >= -skin &&
    ly <= volume.size[1] + skin
  );
}

/**
 * The per-pixel decision, expressed once so the shader and the scenarios cannot drift.
 *
 * A coarse furniture box is NOT proof that every enclosed pixel belongs to that
 * furniture (M8-C.4). A pixel is only replaced when the surface the camera actually sees
 * there is inside an erasure volume, is not inside a retained one, and is not
 * foreground. Anything uncertain stays on camera pixels.
 */
export function shouldErase(
  worldPoint: Vec3,
  input: {
    volumes: readonly ErasureVolume[];
    retained: readonly ErasureVolume[];
    /** ARKit confidence 0..2; below `minConfidence` the depth is not trusted. */
    depthConfidence: number;
    minConfidence: number;
    /** Person-segmentation coverage 0..1 at this pixel. */
    foreground: number;
    /** False when the region came from a ray-box test rather than from depth. */
    hasDepth?: boolean;
  },
): boolean {
  if (input.foreground > 0.5) return false;
  // Confidence only means anything about a depth sample. With no depth there is no
  // sample to distrust, and gating on it would reject every pixel.
  if (input.hasDepth !== false && input.depthConfidence < input.minConfidence) return false;
  // Retained furniture wins ties: a pixel inside both a retained and an erased volume
  // is ambiguous, and keeping the camera there is the answer that cannot be wrong in a
  // way the user sees as their sofa disappearing.
  for (const volume of input.retained) if (insideVolume(worldPoint, volume, 0)) return false;
  for (const volume of input.volumes) if (insideVolume(worldPoint, volume, 0.02)) return true;
  return false;
}

/**
 * Whether the compositor should be drawing this frame.
 *
 * Extracted from the renderer and exported because it was an inline boolean nobody
 * could assert on, and it silently carried `!!shell` long after the fill stopped
 * needing one — so the compositor never mounted without a reconstruction, the shader
 * never ran, and "hide it" changed state without changing a pixel.
 *
 * A shell is NOT in this list. It improves the fill; it does not enable it.
 */
export function shouldComposite(input: {
  /** A live camera frame exists at all. */
  hasCameraFrame: boolean;
  /** A developer diagnostic view is showing, which owns the draw instead. */
  diagnosticActive: boolean;
  /** The native texture bridge is present AND has not starved. */
  bridgeUsable: boolean;
  erasing: number;
}): boolean {
  return (
    input.hasCameraFrame &&
    !input.diagnosticActive &&
    input.bridgeUsable &&
    input.erasing > 0
  );
}
