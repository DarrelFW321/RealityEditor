import Constants from 'expo-constants';

/**
 * Where the backend lives, from the device's point of view.
 *
 * `localhost` is the phone itself, so a physical device needs the Mac's LAN address —
 * and that address changes whenever the Mac joins a different network. Hard-coding it
 * in `.env` means the app silently loses its backend every time that happens, which
 * presents as "voice is broken" or "reconstruction never runs" rather than as a
 * stale IP.
 *
 * So the dev server is asked instead. Metro already told the device where it is, and
 * that host is by definition reachable from the phone: it is how the JS bundle
 * arrived. An explicit `EXPO_PUBLIC_API_URL` still wins, for pointing at a real
 * deployment.
 */
export function apiURL(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  // `hostUri` is "192.168.2.22:8081" in a dev client, absent in a production build.
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    '';
  const host = hostUri.split(':')[0]?.trim();
  // A bare hostname only: anything else and we would be building a URL out of a
  // guess, which is worse than falling back to a wrong-but-predictable default.
  if (host && /^[\w.-]+$/.test(host) && host !== 'localhost' && host !== '127.0.0.1')
    return `http://${host}:${PORT}`;

  return `http://localhost:${PORT}`;
}

const PORT = 8787;

/** For diagnostics: says which of the two sources answered. */
export function apiURLSource(): 'env' | 'metro' | 'default' {
  if (process.env.EXPO_PUBLIC_API_URL?.trim()) return 'env';
  const host = (Constants.expoConfig?.hostUri ?? '').split(':')[0];
  return host && host !== 'localhost' && host !== '127.0.0.1' ? 'metro' : 'default';
}
