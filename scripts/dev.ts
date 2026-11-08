import { createServer } from "node:net";
import { spawn } from "node:child_process";
async function free(start: number) {
  for (let port = start; port < start + 100; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("No free development port.");
}
const api = await free(Number(process.env.API_PORT || 4184));
let web = await free(Number(process.env.WEB_PORT || 4183));
if (web === api) web = await free(api + 1);
const env = { ...process.env, API_PORT: String(api), WEB_PORT: String(web) };
const children = [
  spawn("node", ["--import", "tsx", "server/index.ts"], {
    stdio: "inherit",
    env,
  }),
  spawn("node", ["node_modules/vite/bin/vite.js"], { stdio: "inherit", env }),
];
console.log(`Mirage interface: http://127.0.0.1:${web}`);
console.log("Workspace access code: npm run token");
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => {
    if (!closing) stop(code || 0);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
