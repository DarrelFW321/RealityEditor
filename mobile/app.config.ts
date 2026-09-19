import type { ExpoConfig } from 'expo/config';
const development = process.env.APP_VARIANT !== 'production';
const config: ExpoConfig = {
  name: development ? 'Reality Editor Dev' : 'Reality Editor',
  slug: 'reality-editor',
  scheme: 'reality-editor',
  version: '0.1.0',
  orientation: 'default',
  ios: {
    bundleIdentifier: development ? 'app.realityeditor.dev' : 'app.realityeditor.mobile',
    infoPlist: {
      NSCameraUsageDescription: 'Calibrate your room and point at objects.',
      NSMicrophoneUsageDescription: 'Edit your room with your voice.',
    },
  },
  android: {
    permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
    package: development ? 'app.realityeditor.dev' : 'app.realityeditor.mobile',
  },
  plugins: [
    'expo-router',
    ['expo-sensors', { motionPermission: 'Allow Reality Editor to measure your 360-degree room sweep.' }],
    '@config-plugins/react-native-webrtc',
    ['expo-build-properties', { ios: { deploymentTarget: '17.0' } }],
  ],
  experiments: { typedRoutes: true },
};
export default config;
