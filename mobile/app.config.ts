import type { ExpoConfig } from 'expo/config';
const development = process.env.APP_VARIANT !== 'production';
const config: ExpoConfig = {
  name: development ? 'Dex Dev' : 'Dex',
  slug: 'reality-editor',
  scheme: 'reality-editor',
  version: '0.1.0',
  orientation: 'default',
  ios: {
    bundleIdentifier: development ? 'app.realityeditor.dev' : 'app.realityeditor.mobile',
    infoPlist: {
      NSCameraUsageDescription: 'Calibrate your room and point at objects.',
      NSMicrophoneUsageDescription: 'Edit your room with your voice.',
      /**
       * iOS 26 TRAPS AT LAUNCH WITHOUT THIS.
       *
       * Apps built against the iOS 26 SDK must declare scene-lifecycle adoption.
       * UIKit calls `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`
       * while creating the first scene and raises EXC_BREAKPOINT before any app code
       * runs — which presents as the app closing instantly with no error anywhere.
       *
       * An empty manifest with multiple scenes disabled opts into the single-window
       * behaviour this app already has: there is one AppDelegate and no scene
       * delegate, so nothing about the runtime changes. It is the DECLARATION that
       * iOS 26 is checking for.
       */
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
      },
    },
  },
  android: {
    permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
    package: development ? 'app.realityeditor.dev' : 'app.realityeditor.mobile',
  },
  plugins: [
    'expo-router',
    ['expo-sensors', { motionPermission: 'Allow Dex to measure your 360-degree room sweep.' }],
    '@config-plugins/react-native-webrtc',
    ['expo-build-properties', { ios: { deploymentTarget: '17.0' } }],
  ],
  experiments: { typedRoutes: true },
};
export default config;
