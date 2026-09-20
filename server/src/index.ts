import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { CalibrationStore } from './reconstruction/store.js';
import { HttpReconstructionProvider } from './reconstruction/provider.js';
import { ObjectStore } from './objects/store.js';
import { MeshyObjectProvider } from './objects/provider.js';
import { config } from './config.js';

let log: ((code: string, detail: string) => void) | undefined;
const store = new CalibrationStore(
  resolve(process.env.SESSION_STORAGE_DIR ?? '.sessions'),
  process.env.RECONSTRUCTION_WORKER_URL
    ? new HttpReconstructionProvider(
        process.env.RECONSTRUCTION_WORKER_URL,
        process.env.RECONSTRUCTION_WORKER_TOKEN ?? '',
      )
    : null,
  (code, detail) => log?.(code, detail),
);
const objects = new ObjectStore(
  resolve(config.objects.storageDir),
  config.objects.meshyApiKey ? new MeshyObjectProvider(config.objects.meshyApiKey) : null,
  config.objects.catalogDir ? resolve(config.objects.catalogDir) : null,
  (code, detail) => log?.(code, detail),
);
const app = await buildApp({ calibration: store, objects });
// Indirected through `log` because the store is constructed before the app that owns the
// logger. Reason strings only; the redaction list already covers request headers.
log = (code, detail) => app.log.error({ code, detail }, 'reconstruction');

// SHUT DOWN ON PURPOSE, NOT BY BEING KILLED.
//
// Fastify installs no signal handlers of its own — that is fastify-cli, which this project
// does not use. Without these, `app.close()` never ran, so the `onClose` hook that calls
// `store.close()` was unreachable and every Ctrl-C, container stop or deploy left the whole
// session tree (keyframe JPEGs included) on disk until the next successful boot happened to
// wipe it. Uploaded camera frames outliving the process is exactly what the 24h expiry
// promise is supposed to prevent.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, releasing sessions`);
    void app
      .close()
      .catch((error) => app.log.error(error))
      .finally(() => process.exit(0));
  });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `reality-editor server ready. reconstruction: ${store.providerId ?? 'not configured'}, ` +
      `objects: ${objects.providerId ?? 'not configured'} (${objects.catalogInfo.entries} catalog)`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
