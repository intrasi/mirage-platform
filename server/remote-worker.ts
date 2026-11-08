import Fastify from "fastify";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { LocalExecutor } from "./executor.js";
import { original, incorrect, transform } from "./sample.js";
import { hash, dataDir } from "./config.js";
import { inputSchema } from "../shared/schema.js";

export function allowedSource(source: string) {
  if (source === original || source === incorrect) return true;
  const key = Number(
    source.match(/volatile uint32_t mask = (\d+)u;/)?.[1] || 17,
  );
  if (!Number.isInteger(key) || key < 1 || key > 65535) return false;
  return (["encoded", "control-flow", "algebraic"] as const).some(
    (name) =>
      source ===
      transform({ transform: name, key, reason: "verified catalog" }),
  );
}
export function createRemoteWorker(token: string) {
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, logger: false });
  const engine = new LocalExecutor();
  let active = false;
  app.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const a = Buffer.from(auth),
      b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return reply.code(401).send({ error: "Worker authentication failed." });
  });
  app.setErrorHandler((e: any, _req, reply) =>
    reply.code(e.statusCode || 400).send({ error: e.message }),
  );
  app.post("/v1/:action", async (req: any, reply) => {
    const action = req.params.action;
    if (action === "capabilities")
      return {
        ...(await engine.capabilities()),
        hosted: true,
        scope: "trusted catalog only",
        isolation:
          "Operator must attest the enclosing VM. This process is not an isolation boundary.",
      };
    if (active) return reply.code(429).send({ error: "The worker is busy." });
    active = true;
    const controller = new AbortController();
    req.raw.on("aborted", () => controller.abort());
    try {
      const dir = resolve(dataDir, "remote-work", randomUUID());
      await mkdir(dir, { recursive: true });
      if (action === "prove" || action === "build") {
        const b = z
          .object({
            source: z.string().max(16000),
            reproduce: z.boolean().optional(),
          })
          .strict()
          .parse(req.body);
        if (!allowedSource(b.source))
          throw new Error("Only the trusted calibration catalog is supported.");
        if (action === "prove")
          return await engine.prove(b.source, dir, controller.signal);
        const result = await engine.build(
          b.source,
          dir,
          controller.signal,
          b.reproduce,
        );
        await mkdir(resolve(dataDir, "remote-binaries"), { recursive: true });
        await writeFile(
          resolve(dataDir, "remote-binaries", result.binaryHash),
          result.binary,
          { mode: 0o600 },
        );
        return { ...result, binary: result.binary.toString("base64") };
      }
      if (action === "execute") {
        const b = z
          .object({
            binary: z.string().max(3000000),
            input: z
              .array(
                z.tuple([z.number().int(), z.number().int(), z.number().int()]),
              )
              .min(1)
              .max(11000),
          })
          .strict()
          .parse(req.body);
        for (const [raw, gain_q8, offset] of b.input)
          inputSchema.parse({ raw, gain_q8, offset });
        const binary = Buffer.from(b.binary, "base64");
        const saved = await readFile(
          resolve(dataDir, "remote-binaries", hash(binary)),
        ).catch(() => null);
        if (!saved || !saved.equals(binary))
          throw new Error("This binary was not built by the trusted worker.");
        return await engine.execute(binary, dir, b.input, controller.signal);
      }
      return reply.code(404).send({ error: "Unknown worker action." });
    } finally {
      active = false;
    }
  });
  return app;
}
if (
  process.argv[1]?.endsWith("remote-worker.js") ||
  process.argv[1]?.endsWith("remote-worker.ts")
) {
  const token = process.env.MIRAGE_WORKER_TOKEN;
  if (!token || token.length < 32)
    throw new Error("Set a worker token with at least 32 characters.");
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The hosted demo worker requires Linux x86-64.");
  await createRemoteWorker(token).listen({
    host: "0.0.0.0",
    port: Number(process.env.WORKER_PORT || 4190),
  });
}
