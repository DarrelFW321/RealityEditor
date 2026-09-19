// Metro config exists for exactly one reason: to keep `three` off its
// deprecated CommonJS entry point.
//
// THE BUG THIS FIXES. three 0.186 made the package ESM-only and left
// `build/three.cjs` behind as a shim whose first statement is:
//
//     process.emitWarning( '`require("three")` is deprecated ...' )
//
// `process.emitWarning` is a Node API. React Native's `process` shim defines
// `process.env` and nothing else (see react-native/Libraries/Core/setUpGlobals.js),
// so under Hermes that call is undefined and throws
//
//     undefined is not a function      at three/build/three.cjs:12
//
// `@react-three/fiber`'s CJS build does `require('three')`, and three's
// `exports` map sends the `require` condition straight at that shim — so the
// crash surfaced on the first line that imports R3F (`SceneView.tsx:2`) even
// though nothing was wrong with that file.
//
// Forcing the `import` condition for this one package resolves `three` to
// `build/three.module.js` instead. Metro transpiles the ESM to CJS itself, so
// R3F's `require('three')` still gets the namespace object it expects.
//
// Scoped to `three` deliberately. Flipping `unstable_conditionNames` globally
// would push every dependency onto its ESM build, which is a much larger change
// and breaks anything that is CJS-only.
//
// NOTE: monorepo resolution needs nothing here. Expo's autolinking resolver
// already walks up to the workspace root — the build log says
// "Expo Autolinking module resolution enabled" and resolves ../node_modules
// correctly on its own.

const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// SECOND FIX: exactly one react-native-gesture-handler in the bundle.
//
// Two copies were installed — 2.32.0 nested in mobile/ (mobile's own pin) and
// 3.3.0 hoisted at the workspace root. Nothing actually required 3.x:
// expo-router declares the peer as `"*"` and optional, so npm was free to float
// it to latest.
//
// 2.32.0 is the correct one, and not by preference:
//   - Expo SDK 57's bundledNativeModules.json pins ~2.32.0
//   - mobile/package.json pins ~2.32.0
//   - Pods compiled RNGestureHandler 2.32.0 — the actual binary in the app
//
// A 3.3.0 JS copy can never match that binary, and two JS instances against one
// native registration is the classic cause of "undefined is not a function".
//
// This is enforced here rather than with npm `overrides` because npm 10.9.8
// would not apply them: the lockfile kept `overrides: null` and reinstalled
// 3.3.0 even with --force. The override is still declared in the root
// package.json so a future npm (or a clean install) resolves correctly, but the
// bundle must not depend on that being fixed.
const GESTURE_HANDLER = path.resolve(__dirname, 'node_modules/react-native-gesture-handler');

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'react-native-gesture-handler' ||
    moduleName.startsWith('react-native-gesture-handler/')
  ) {
    const subpath = moduleName.slice('react-native-gesture-handler'.length);
    return context.resolveRequest(
      { ...context, originModulePath: path.join(GESTURE_HANDLER, 'index.js') },
      '.' + (subpath || '/'),
      platform,
    );
  }
  if (moduleName === 'three' || moduleName.startsWith('three/')) {
    return context.resolveRequest(
      // `import` first so the ESM entry wins; `react-native` is kept so any
      // subpath that offers a platform-specific build still gets it.
      { ...context, unstable_conditionNames: ['import', 'react-native'] },
      moduleName,
      platform,
    );
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
