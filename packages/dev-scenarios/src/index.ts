export * from './captures';
import type { EditorState, Rsg, SceneObject } from '@reality/contracts';
import room from '../../../contracts/fixtures/rooms/bedroom_4x4.rsg.json';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function base(): { measured: Rsg; design: Rsg } {
  return { measured: clone(room) as Rsg, design: clone(room) as Rsg };
}

function state(measured: Rsg, design: Rsg, removedPhysicalIds: string[]): EditorState {
  return {
    schemaVersion: 1,
    sessionId: `sample-${Date.now()}`,
    calibrationId: 'sample-calibration',
    frameId: 'sample-world',
    revision: 0,
    calibrationRevision: 0,
    provenance: 'sample',
    measured,
    design,
    assemblies: {},
    removedPhysicalIds,
    removalMaskIds: [],
  };
}

/** A clearly labeled development scene, never a successful real calibration. */
export function sampleRoom(): EditorState {
  const { measured, design } = base();
  design.objects = [];
  design.relations = [];
  return state(measured, design, measured.objects.map((o) => o.id));
}

/**
 * The empty room has nothing to collide with, so it cannot show overlap rejection.
 * This one keeps the scanned bed, desk and chair as real obstacles.
 */
export function sampleRoomFurnished(): EditorState {
  const { measured, design } = base();
  return state(measured, design, []);
}

const BUILT_IN: SceneObject = {
  id: 'obj_wardrobe_builtin',
  class: 'storage',
  refined_class: 'built-in wardrobe',
  dimensions: [1, 2, 0.6],
  // Against the south wall, clear of the bed, the desk and the door swing.
  pose: { position: [-1.2, 0, 1.7], yaw: 0 },
  pivot: 'base_center',
  material_ref: '#8c9298',
  asset_ref: null,
  movable: false,
  provenance: 'real',
  salience: 0.6,
  state: 'present',
};

/** Adds something the solver must refuse to move. */
export function sampleRoomWithBuiltIn(): EditorState {
  const { measured, design } = base();
  measured.objects = [...measured.objects, clone(BUILT_IN)];
  design.objects = [...design.objects, clone(BUILT_IN)];
  return state(measured, design, []);
}
