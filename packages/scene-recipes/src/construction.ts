import type {
  Assembly,
  ConstructionFinding,
  ConstructionResult,
  MaterialClass,
  Part,
  Template,
  Vec3,
} from '@reality/contracts';
import {
  ENVELOPES,
  MATERIAL_LIMITS,
  TEMPLATE_VERSIONS,
  assumptionsFor,
  supportedAlternative,
} from './templates';

/**
 * M7.5 construction validation.
 *
 * Five checks, each producing a finding carrying the authored limit and the measured
 * value, so a refusal can say *which* rule and *by how much* rather than "invalid".
 * Pure and deterministic: the same assembly always yields the same result, which is
 * what lets a proposal be replayed and compared.
 *
 * This deliberately does not look at `part.color`. Cosmetic colour and structural
 * material are separate inputs, and conflating them would mean repainting a shelf
 * changed whether it was judged to hold books.
 */

/** Two parts count as joined when their boxes overlap or touch within this gap. */
const CONTACT_TOLERANCE_M = 0.002;
/** A declared load must sit this far inside the support polygon to count as balanced. */
const BALANCE_MARGIN_M = 0.02;

type Box = { lo: Vec3; hi: Vec3 };

function boxOf(part: Part): Box {
  return {
    lo: [
      part.center[0] - part.size[0] / 2,
      part.center[1] - part.size[1] / 2,
      part.center[2] - part.size[2] / 2,
    ],
    hi: [
      part.center[0] + part.size[0] / 2,
      part.center[1] + part.size[1] / 2,
      part.center[2] + part.size[2] / 2,
    ],
  };
}

/** True when the boxes overlap or touch on every axis. */
function touching(a: Box, b: Box): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.lo[i]! - b.hi[i]! > CONTACT_TOLERANCE_M) return false;
    if (b.lo[i]! - a.hi[i]! > CONTACT_TOLERANCE_M) return false;
  }
  return true;
}

/** Andrew's monotone chain. Deterministic: the input is sorted before hulling. */
export function convexHull(points: readonly [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (input: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0)
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * Signed distance from a point to the inside of a convex polygon, in metres.
 * Positive means inside by that much. A degenerate hull (0-2 points) is never inside.
 */
export function insetDistance(point: [number, number], polygon: readonly [number, number][]): number {
  if (polygon.length < 3) return -Infinity;
  let worst = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const length = Math.hypot(ex, ez);
    if (length < 1e-9) continue;
    // Hull from `convexHull` is counter-clockwise, so inside is to the left of each edge.
    const side = (ex * (point[1] - a[1]) - ez * (point[0] - a[0])) / length;
    worst = Math.min(worst, side);
  }
  return worst === Infinity ? -Infinity : worst;
}

/**
 * The longest unsupported horizontal run a load-bearing top has between its supports.
 *
 * The longest EDGE of the support hull, not the longest distance between any two
 * supports. On a four-leg rectangle the diagonal is the largest number and the wrong
 * one: that line is braced by rails on both sides, so quoting it would fail every
 * ordinary bed. The perimeter edges are the runs that actually sag.
 */
export function longestSpan(supports: readonly [number, number][], [w, , d]: Vec3): number {
  // Nothing underneath means the member is held at its mount, so its span is its extent.
  if (supports.length < 2) return Math.max(w, d);
  if (supports.length === 2)
    return Math.hypot(supports[0]![0] - supports[1]![0], supports[0]![1] - supports[1]![1]);
  const hull = convexHull(supports);
  if (hull.length < 2) return Math.max(w, d);
  let longest = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    longest = Math.max(longest, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return longest;
}

export type ValidationInput = {
  family: Template;
  dimensions: Vec3;
  legs: number;
  materialClass: MaterialClass;
  parts: readonly Part[];
  connections: readonly { from: string; to: string }[];
  supports: readonly [number, number][];
  loadCases: readonly { id: string; at: [number, number]; newtons: number }[];
  /** Set once a support has actually been resolved; unresolved is not a failure. */
  supportResolved?: boolean;
};

/**
 * Runs every authored check and folds the findings into one of the four statuses.
 *
 * Severity order is fixed: a missing template outranks a broken one, which outranks a
 * dimension that merely leaves the authored envelope. That ordering is what decides
 * whether the planner refuses, adjusts, or commits with a caveat.
 */
export function validateConstruction(input: ValidationInput): ConstructionResult {
  const { family, dimensions, legs, materialClass, parts } = input;
  const [w, h, d] = dimensions;
  const version = TEMPLATE_VERSIONS[family];
  const envelope = ENVELOPES[family];
  const findings: ConstructionFinding[] = [];
  const assumptions = assumptionsFor(family, materialClass);

  // 1. Positive dimensions. Checked first because every later check divides by them.
  if (![w, h, d].every((v) => Number.isFinite(v) && v > 0)) {
    findings.push({
      code: 'dimension_non_positive',
      detail: 'Every dimension must be greater than zero.',
      limit: 0,
      actual: Math.min(w, h, d),
    });
    return { status: 'unsupported', template: family, templateVersion: version, materialClass, findings, assumptions };
  }

  // 2. An authored support count. THIS is the three-legged-bed gate: there is no
  //    three-support bed template, so the answer is "not authored", never a bed mesh
  //    with a leg quietly removed.
  if (envelope.supportCounts.length && !envelope.supportCounts.includes(legs)) {
    const alternative = supportedAlternative(family, legs);
    findings.push({
      code: 'no_authored_template',
      detail: `No authored ${legs}-support ${family} template with edge-load checks${
        alternative ? `; ${alternative} is supported` : ''
      }.`,
      limit: envelope.supportCounts[0] ?? null,
      actual: legs,
    });
    return { status: 'unsupported', template: family, templateVersion: version, materialClass, findings, assumptions };
  }

  // 3. Connected construction: every authored join must be geometrically real, and the
  //    parts must form a single component. A template that produces two floating halves
  //    passes a box check and fails this one.
  const boxes = new Map(parts.map((p) => [p.id, boxOf(p)]));
  const adjacency = new Map<string, Set<string>>(parts.map((p) => [p.id, new Set<string>()]));
  for (const { from, to } of input.connections) {
    const a = boxes.get(from);
    const b = boxes.get(to);
    if (!a || !b || !touching(a, b)) {
      findings.push({
        code: 'disconnected',
        detail: `Authored join ${from}–${to} does not meet in this geometry.`,
        limit: CONTACT_TOLERANCE_M,
        actual: null,
      });
      continue;
    }
    adjacency.get(from)!.add(to);
    adjacency.get(to)!.add(from);
  }
  if (parts.length > 1 && input.connections.length) {
    const seen = new Set<string>([parts[0]!.id]);
    const queue = [parts[0]!.id];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    if (seen.size !== parts.length)
      findings.push({
        code: 'disconnected',
        detail: `${parts.length - seen.size} part(s) are not joined to the rest of the assembly.`,
        limit: parts.length,
        actual: seen.size,
      });
  }

  // 4. Span and thickness, against the declared material. An undeclared material has no
  //    authored limits, so this is skipped and the whole result degrades to `unknown`
  //    rather than silently passing.
  const limits = MATERIAL_LIMITS[materialClass];
  if (limits) {
    const span = longestSpan(input.supports, dimensions);
    // The family's own bracing is an authored multiplier on the bare material span.
    const allowed = limits.maxSpanM * envelope.spanFactor;
    if (span > allowed)
      findings.push({
        code: 'span_exceeded',
        detail: `A braced ${family} in ${materialClass} spans up to ${allowed.toFixed(2)}m between supports; this one spans ${span.toFixed(2)}m.`,
        limit: Number(allowed.toFixed(4)),
        actual: Number(span.toFixed(4)),
      });
    const thinnest = parts
      .filter((p) => p.structural)
      .reduce((min, p) => Math.min(min, Math.min(...p.size)), Infinity);
    if (Number.isFinite(thinnest) && thinnest < limits.minThicknessM)
      findings.push({
        code: 'thickness_below_minimum',
        detail: `Thinnest structural member is ${(thinnest * 1000).toFixed(0)}mm; ${materialClass} needs ${(limits.minThicknessM * 1000).toFixed(0)}mm.`,
        limit: limits.minThicknessM,
        actual: Number(thinnest.toFixed(4)),
      });
  }

  // 5. Support contact and balance. The support polygon is the ground-contact hull, not
  //    the bounding box: a tripod's hull is a triangle, and an edge load outside it tips
  //    the object over however large its footprint looks.
  const hull = convexHull(input.supports);
  if (input.supportResolved === false)
    findings.push({
      code: 'support_contact',
      detail: 'No support surface has been resolved for this object yet.',
      limit: null,
      actual: null,
    });
  if (envelope.supportCounts.some((c) => c > 0)) {
    for (const load of input.loadCases) {
      const inset = insetDistance(load.at, hull);
      if (inset < BALANCE_MARGIN_M)
        findings.push({
          code: 'unbalanced',
          detail: `The ${load.id} load (${load.newtons}N) falls ${
            inset < 0 ? 'outside' : 'within ' + (inset * 1000).toFixed(0) + 'mm of'
          } the support polygon.`,
          limit: BALANCE_MARGIN_M,
          actual: Number(inset.toFixed(4)),
        });
    }
  }

  // 6. The authored envelope. Outside it is `unknown`, never `invalid`: the template may
  //    well work, but this template has not been authored to say so.
  const outside =
    w < envelope.widthM[0] ||
    w > envelope.widthM[1] ||
    h < envelope.heightM[0] ||
    h > envelope.heightM[1] ||
    d < envelope.depthM[0] ||
    d > envelope.depthM[1];
  if (outside)
    findings.push({
      code: 'outside_envelope',
      detail: `${w.toFixed(2)}×${h.toFixed(2)}×${d.toFixed(2)}m is outside the authored ${family} envelope.`,
      limit: envelope.widthM[1],
      actual: Number(Math.max(w, h, d).toFixed(4)),
    });

  const has = (code: ConstructionFinding['code']) => findings.some((f) => f.code === code);
  const status: ConstructionResult['status'] = has('disconnected')
    ? 'unsupported'
    : has('unbalanced') || has('span_exceeded') || has('thickness_below_minimum')
      ? 'needs-adjustment'
      : !limits || has('outside_envelope') || has('support_contact')
        ? 'unknown'
        : 'valid-within-template';

  return { status, template: family, templateVersion: version, materialClass, findings, assumptions };
}

/**
 * Re-runs validation for an assembly already in a scene, after any change that can
 * invalidate it: dimensions, support, orientation or structural material (M7.5.3).
 *
 * `legs` defaults to the number of ground contacts the assembly ACTUALLY has, which is
 * the only reliable source. Passing a nominal 3-or-4 instead reported every shelf and
 * frame as an unauthored four-support variant, because those families are authored
 * with no legs at all.
 */
export function revalidate(
  assembly: Assembly,
  dimensions: Vec3,
  legs: number = assembly.supports.length,
): ConstructionResult {
  return validateConstruction({
    family: assembly.template,
    dimensions,
    legs,
    materialClass: assembly.materialClass,
    parts: assembly.parts,
    connections: assembly.connections,
    supports: assembly.supports as [number, number][],
    loadCases: assembly.loadCases,
    supportResolved: assembly.support.surfaceId.length > 0,
  });
}

/** The one sentence a refusal or caveat quotes. Empty when nothing needs saying. */
export function describeConstruction(result: ConstructionResult): string {
  if (result.status === 'valid-within-template') return '';
  const first = result.findings[0];
  if (!first) return `Construction is ${result.status} for the ${result.template} template.`;
  return first.detail;
}
