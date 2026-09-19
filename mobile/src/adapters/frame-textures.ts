import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { TextureFrameSource } from '../runtime/frame-textures';

type NativeTextures = {
  acquireTextureFrame(contextId: number, frameId: string, width: number, height: number): Promise<unknown>;
  releaseTextureFrame(leaseId: string): Promise<void>;
  invalidateTextureFrames(): Promise<void>;
};
const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<NativeTextures>('SpatialCapture') : null;

// Old development binaries remain usable; they cannot enable this diagnostic.
export const textureBridgeAvailable = () => typeof native?.acquireTextureFrame === 'function';
export const nativeTextureSource: TextureFrameSource = {
  acquire: r => native?.acquireTextureFrame(r.contextId, r.frameId, r.width, r.height) ?? Promise.resolve(null),
  release: id => native?.releaseTextureFrame(id) ?? Promise.resolve(),
};
