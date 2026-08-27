import { createApp } from './app.ts';
import { config } from './config.ts';
import { store } from './data/store.ts';

// No traffic until the dataset is there. The local file is the source of truth; upstream is
// only consulted to see whether it has something newer.
console.log(`[boot] loading dataset from ${config.datasetPath}`);

await store.init();

const { source, models, etag } = store.snapshot;
if (store.lastError) {
  console.warn(`[boot] upstream unreachable (${store.lastError}); serving the local dataset`);
}
console.log(
  `[boot] dataset loaded from ${source}: ${models.length} models, etag ${etag ?? 'unknown'}`,
);

const server = createApp().listen(config.port, () => {
  console.log(`[boot] listening on :${config.port}`);
});

// Cloud Run sends SIGTERM before retiring the instance.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => process.exit(0));
  });
}
