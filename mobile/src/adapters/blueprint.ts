import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform, Share } from 'react-native';
import { buildPlan, type PlanOptions, type PlanSheet } from '@reality/blueprint';
import type { EditorState } from '@reality/contracts';

type NativeBlueprint = {
  /** Returns the `file://` URL of the rendered page. */
  blueprintPDF(sheetJSON: string, fileName: string, title: string): Promise<string>;
};

const native =
  Platform.OS === 'ios' ? requireOptionalNativeModule<NativeBlueprint>('SpatialCapture') : null;

/**
 * Whether this binary can ink a page.
 *
 * A development build made before this milestone has the module but not the function, and
 * `requireOptionalNativeModule` will hand it over quite happily. Checking the function
 * rather than the module is what keeps the button honest on an old binary — the same
 * check `textureBridgeAvailable` makes, for the same reason.
 */
export const blueprintAvailable = () => typeof native?.blueprintPDF === 'function';

const stamp = (now: number) => new Date(now).toISOString().slice(0, 10);

export type BlueprintExport = { uri: string; shared: boolean };

/**
 * Ink a sheet and hand it to the share sheet.
 *
 * Takes the SHEET, not the scene. Building it again here would mean exporting whatever
 * the room had become by the time the button was pressed — and the room can still move
 * under an open modal, because voice keeps running. Then the page that came out would
 * not be the page that was looked at, which is the one promise a preview makes.
 *
 * `Share` is React Native's own, not `expo-sharing`: iOS passes a `file://` url straight
 * to `UIActivityViewController`, which previews the PDF, prints it, mails it or saves it
 * to Files. One fewer native module to add for something already in the box.
 */
export async function exportBlueprint(
  sheet: PlanSheet,
  options: { fileName?: string; title?: string; now?: number } = {},
): Promise<BlueprintExport> {
  if (!native?.blueprintPDF) throw new Error('This build cannot draw a blueprint.');
  const title = options.title ?? 'FLOOR PLAN';
  const fileName = options.fileName ?? `floor-plan-${stamp(options.now ?? Date.now())}.pdf`;
  const uri = await native.blueprintPDF(JSON.stringify(sheet), fileName, title);
  const result = await Share.share({ url: uri, title: fileName });
  return { uri, shared: result.action === Share.sharedAction };
}

/** The sheet the preview draws, and the one the export inks. */
export function previewSheet(scene: EditorState, options: PlanOptions = {}): PlanSheet {
  return buildPlan(scene, options);
}
