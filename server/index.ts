import { createApp } from "./app.js";
const { app, store, worker } = createApp();
const port = Number(process.env.API_PORT || 4184);
await app.listen({ host: "127.0.0.1", port });
store.prune(Number(process.env.MIRAGE_RETENTION_DAYS || 7));
worker.start();
console.log(`Mirage service: http://127.0.0.1:${port}`);
console.log("Use npm run token to read the local workspace access code.");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await app.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
