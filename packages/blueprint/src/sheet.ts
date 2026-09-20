/**
 * The drawing a renderer receives. RENDERER-AGNOSTIC BY CONSTRUCTION.
 *
 * RoomPlan has no blueprint export — `CapturedRoom.export(to:exportOptions:)` writes USD
 * and nothing else — so the plan has to be drawn from the RSG regardless of which API puts
 * ink on the page. Two things draw it: Core Graphics inside
 * `UIGraphicsPDFRenderer` for the PDF, and react-native-svg for the on-screen preview.
 * Anything either one cannot express is not in this file.
 *
 * That is why there are no arcs. A door swing is a flattened polyline, because an arc
 * means two angle conventions (SVG sweeps, CGContext.addArc) that disagree about which
 * way positive is, and a blueprint whose doors open through the wall on one of the two
 * renderers is worse than one whose arcs are 32 straight segments nobody can see.
 *
 * SHEET SPACE: points (1/72 inch), origin TOP-LEFT, +y DOWN. That is SVG's convention and
 * it is also the convention `UIGraphicsPDFRenderer` hands you — its CGContext arrives
 * already flipped to UIKit's. PDF's own y-up space never appears here.
 */

/** [x, y] in sheet points. */
export type SheetPoint = [number, number];

export type PlanStroke = {
  /** `#rrggbb`. Alpha is deliberately absent: a blueprint is ink or it is nothing. */
  colour: string;
  /** Line weight in points. */
  width: number;
  /** On/off run lengths in points. Absent or empty means solid. */
  dash?: number[];
};

/**
 * Which part of the drawing a primitive belongs to.
 *
 * Carried so a renderer can order its own drawing and so the gate can assert that a
 * measured wall actually produced a wall, rather than counting anonymous polylines.
 */
export type PlanLayer =
  | 'frame'
  | 'wall'
  | 'wall_inferred'
  | 'opening'
  | 'door'
  | 'window'
  | 'object_measured'
  | 'object_added'
  | 'dimension'
  | 'annotation'
  | 'title';

export type PlanPrimitive =
  | {
      kind: 'path';
      layer: PlanLayer;
      /**
       * The entity this shape draws, when it draws one.
       *
       * Carried so a plan can be touched. Hit-testing by colour or by layer would guess;
       * an id is the same identity the solver, the scene graph and the op log all use,
       * so a shape tapped on paper and an object named in speech cannot be different
       * things.
       */
      id?: string;
      points: SheetPoint[];
      /** Whether the last point joins the first. */
      closed: boolean;
      stroke: PlanStroke | null;
      /** `#rrggbb`, or null for an unfilled path. */
      fill: string | null;
    }
  | {
      kind: 'text';
      layer: PlanLayer;
      at: SheetPoint;
      text: string;
      sizePt: number;
      colour: string;
      /** Horizontal placement of `at` within the run of text. */
      align: 'left' | 'centre' | 'right';
      /** Vertical meaning of `at`. `middle` centres the cap height on it. */
      baseline: 'top' | 'middle';
      /** Clockwise on screen, about `at`. Zero for everything but wall lengths. */
      rotationDeg: number;
      bold: boolean;
    };

/**
 * How room metres became sheet points.
 *
 * Every coordinate in the sheet went through this, so publishing it is what makes the
 * drawing reversible — a finger at a point on the page can be turned back into a place
 * in the room. Without it the plan is a picture; with it the plan is a view.
 *
 * `sheet = offset + room * scale`, with room x -> sheet x and room z -> sheet y.
 */
export type PlanProjection = {
  /** Sheet points per room metre. */
  scale: number;
  offsetX: number;
  offsetY: number;
};

/** One page. Everything needed to draw it, and nothing that has to be recomputed. */
export type PlanSheet = {
  /** Page size in points. A4 landscape is 842 x 595. */
  width: number;
  height: number;
  /** `50` means 1:50. Null when the room did not fit any standard ratio. */
  scaleRatio: number | null;
  /** What the title block prints, e.g. `1:50` or `NOT TO SCALE`. */
  scaleLabel: string;
  projection: PlanProjection;
  primitives: PlanPrimitive[];
};

/** Room [x, z] metres to sheet points. */
export const toSheet = (p: PlanProjection, room: readonly [number, number]): SheetPoint => [
  p.offsetX + room[0] * p.scale,
  p.offsetY + room[1] * p.scale,
];

/** Sheet points back to room [x, z] metres. */
export const toRoom = (p: PlanProjection, sheet: readonly [number, number]): [number, number] => [
  (sheet[0] - p.offsetX) / p.scale,
  (sheet[1] - p.offsetY) / p.scale,
];

/**
 * How a page sits inside the box it is drawn in.
 *
 * SVG's default `preserveAspectRatio` is `xMidYMid meet`: the page is scaled to fit and
 * CENTRED, leaving bars on two sides. A touch handler that ignores those bars is off by
 * half of them everywhere — which at 1:30 is tens of centimetres of room, in the same
 * direction every time, so it reads as the app being confidently wrong rather than
 * imprecise. Pure, and here rather than in the component, so it can be checked.
 */
export type PageFit = { scale: number; offsetX: number; offsetY: number };

export function fitPage(
  sheet: { width: number; height: number },
  box: { width: number; height: number },
): PageFit {
  const scale = Math.min(box.width / sheet.width, box.height / sheet.height);
  return {
    scale,
    offsetX: (box.width - sheet.width * scale) / 2,
    offsetY: (box.height - sheet.height * scale) / 2,
  };
}

/** A touch in view coordinates, as a point on the page. */
export const viewToSheet = (fit: PageFit, x: number, y: number): SheetPoint => [
  (x - fit.offsetX) / fit.scale,
  (y - fit.offsetY) / fit.scale,
];

/** Whether a sheet point lies inside a closed sheet polygon. Ray cast, same as the engine's. */
export function withinShape(point: readonly [number, number], polygon: readonly SheetPoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** A4 landscape at 72 PPI, which is what both renderers measure in. */
export const PAGE = { width: 842, height: 595 } as const;

/**
 * Points per metre at a given ratio. 1pt is 1/72 inch, so 1m at 1:50 is 56.7pt.
 * Kept as a function rather than a table so an unlisted ratio cannot silently mislabel.
 */
export const pointsPerMetre = (ratio: number) => 72 / (0.0254 * ratio);

/**
 * The ratios a drawing may claim, smallest first.
 *
 * A plan that says 1:50 and is not 1:50 is a lie a ruler can catch, so the fit picks from
 * this ladder and falls back to NOT TO SCALE rather than inventing 1:63.4.
 *
 * 1:25, 1:30 and 1:40 are not in ISO 5455's preferred set but are ordinary drawing
 * scales, and the rungs matter: a 4m room with only the preferred ladder drops from
 * 1:20 straight to 1:50 and sits in the middle of the sheet at two fifths the size it
 * could be. Better a real scale that fills the page than a preferred one that wastes it.
 */
export const SCALE_LADDER = [10, 20, 25, 30, 40, 50, 100, 200, 500] as const;

/**
 * The ink.
 *
 * Darker than a drawing sheet wants to be, on purpose. This page is read at A4 in a PDF
 * AND at about a fifth of that inside a phone, where the classic light architectural
 * greys stop being restrained and start being invisible. Contrast is chosen for the
 * small case; the large one can afford it.
 */
export const INK = {
  wall: '#0a1017',
  inferred: '#59646f',
  opening: '#0a1017',
  glass: '#1d5c99',
  measured: '#3f4a55',
  measuredFill: '#e2e7ec',
  added: '#14416b',
  addedFill: '#cfe1f2',
  dimension: '#2f3941',
  frame: '#0a1017',
  paper: '#ffffff',
  note: '#333d46',
} as const;

/** Conservative Helvetica advance, used only to decide whether a label fits. */
export const textWidth = (text: string, sizePt: number) => text.length * sizePt * 0.52;
