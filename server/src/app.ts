import Fastify, { type FastifyInstance } from 'fastify';
import { registerCalibrationRoutes } from './routes/calibrations.js';
import type { CalibrationStore } from './reconstruction/store.js';
import { config } from './config.js';
import { registerSessionRoute } from './routes/session.js';
import { registerPlanStyleRoute } from './routes/plan_style.js';
import { registerInpaintRoute } from './routes/inpaint.js';
import { registerObjectRoutes } from './routes/objects.js';
import type { ObjectStore } from './objects/store.js';

/** Objects is optional so a gate exercising only reconstruction need not build one. */
export interface Stores {
  calibration: CalibrationStore;
  objects?: ObjectStore;
}

/**
 * Builds the app without binding a port.
 *
 * Split out of `index.ts`, which constructed the app and `await app.listen()`d at module
 * scope — importing it started a server. The milestone gate drives every route through
 * Fastify's `inject()` instead: no socket, no port collision, no cleanup, and the same
 * routing, parsing and serialisation a real request goes through.
 *
 * The store is a parameter rather than a module-level singleton so a test can supply one
 * backed by a temporary directory and a fake provider.
 */
export async function buildApp(
  stores: Stores | CalibrationStore,
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  // Accept a bare CalibrationStore so existing callers and gates keep working.
  const { calibration: store, objects } = 'calibration' in stores ? stores : { calibration: stores, objects: undefined };
  const app = Fastify({
    // Only meaningful when there is a logger, and Fastify 5 deprecation-warns on the option
    // itself — passing it with `logger: false` printed a warning per app the gate built.
    ...(options.logger === false ? {} : { disableRequestLogging: true }),
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: ['req.headers.authorization'],
            transport:
              process.env.NODE_ENV === 'production'
                ? undefined
                : {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
                  },
          },
  });

  // Health check. The first thing to curl when the phone says it cannot connect — it
  // distinguishes "server is down" from "server is up, wifi is the problem", which on
  // conference wifi is a question you will ask more than once.
  app.get('/health', async () => ({
    ok: true,
    realtime_model: config.realtime.model,
    openai_key_present: config.openaiApiKey.length > 0,
    planner_model: config.planner.model,
    // Whether reconstruction can run at all. Previously you had to call /capabilities to
    // find out, so a 503 from /reconstruct looked like a bug rather than "no worker set".
    reconstruction: store.providerId,
    // Null when no object store was supplied at all, distinguishing "not wired"
    // from "wired but no provider key".
    objects: objects ? { provider: objects.providerId, catalog: objects.catalogInfo } : null,
  }));

  await registerSessionRoute(app);
  await registerPlanStyleRoute(app);
  await registerInpaintRoute(app);
  await registerCalibrationRoutes(app, store);
  if (objects) await registerObjectRoutes(app, objects);
  return app;
}
