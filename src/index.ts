import { createApp } from './app.ts';
import { config } from './config.ts';
import { store } from './data/store.ts';

// No traffic until the dataset is there: with no local fallback, booting without data is useless.
console.log(`[boot] downloading dataset from ${config.upstreamUrl}`);
await store.init();
console.log(`[boot] dataset loaded: ${store.snapshot.models.length} models`);

store.startAutoRefresh();

const server = createApp().listen(config.port, () => {
  console.log(`[boot] listening on :${config.port}`);
});

// Cloud Run sends SIGTERM before retiring the instance.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received`);
    store.stopAutoRefresh();
    server.close(() => process.exit(0));
  });
}
