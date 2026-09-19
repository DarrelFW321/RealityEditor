import Fastify from 'fastify';
import { resolve } from 'node:path';
import { registerCalibrationRoutes } from './routes/calibrations.js';
import { CalibrationStore } from './reconstruction/store.js';
import { HttpReconstructionProvider } from './reconstruction/provider.js';
import { config } from './config.js';
import { registerSessionRoute } from './routes/session.js';
import { registerPlanStyleRoute } from './routes/plan_style.js';

const app = Fastify({
  disableRequestLogging: true,
  logger: {
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

// Health check. The first thing to curl when the phone says it cannot connect —
// it distinguishes "server is down" from "server is up, wifi is the problem",
// which on conference wifi is a question you will ask more than once.
app.get('/health', async () => ({
  ok: true,
  realtime_model: config.realtime.model,
  openai_key_present: config.openaiApiKey.length > 0,
  anthropic_key_present: config.anthropicApiKey.length > 0,
}));

await registerSessionRoute(app);
await registerPlanStyleRoute(app);
await registerCalibrationRoutes(
  app,
  new CalibrationStore(
    resolve(process.env.SESSION_STORAGE_DIR ?? '.sessions'),
    process.env.RECONSTRUCTION_WORKER_URL
      ? new HttpReconstructionProvider(
          process.env.RECONSTRUCTION_WORKER_URL,
          process.env.RECONSTRUCTION_WORKER_TOKEN ?? '',
        )
      : null,
  ),
);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`reality-editor server ready. POST /session  POST /plan_style  GET /health`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
