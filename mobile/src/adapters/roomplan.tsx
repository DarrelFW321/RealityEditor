import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { Platform, type ViewProps } from 'react-native';
import type { Keyframe } from '@reality/contracts';
import type { TrackedFrame } from './room-conversion';

// The conversion half lives in a React-Native-free module so the milestone gate can replay
// recorded captures under plain node. Re-exported so nothing downstream has to know.
export * from './room-conversion';

const native =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<{ isSupported(): boolean }>('SpatialCapture')
    : null;
export const spatialSupported = () => native?.isSupported() ?? false;
export const SpatialView = native
  ? requireNativeViewManager<
      ViewProps & {
        mode: 'scan' | 'edit' | 'idle';
        /** Room origin in world coordinates. Native pins an ARAnchor here and reports its
         * live transform back on every frame, which is what corrects drift. */
        roomOrigin?: number[] | null;
        onRoom: (e: { nativeEvent: { roomJSON: string; frameId: string } }) => void;
        onFrame: (e: { nativeEvent: TrackedFrame }) => void;
        onStatus: (e: {
          nativeEvent: {
            code: string;
            message: string;
            wallCount?: number;
            floorCount?: number;
            openingCount?: number;
            scanDegrees?: number;
            highResolutionReferences?: boolean;
          };
        }) => void;
        /// A registered visual reference from the measurement sweep. The
        /// metadata half is `Keyframe`; validate with `parseKeyframe` rather
        /// than trusting the bridge.
        onKeyframe: (e: { nativeEvent: Keyframe & { jpegBase64: string } }) => void;
      }
    >('SpatialCapture')
  : null;
