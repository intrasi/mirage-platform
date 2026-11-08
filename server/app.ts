import Fastify from "fastify";
import { timingSafeEqual, randomUUID, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { z, ZodError } from "zod";
import type { ServerResponse } from "node:http";
import {
  profileSchema,
  policySchema,
  inputSchema,
  terminal,
  type Run,
} from "../shared/schema.js";
import { Store } from "./store.js";
import { Worker } from "./worker.js";
import { hash, jsonHash, workspaceToken, root, dataDir } from "./config.js";
import { original, runner } from "./sample.js";
import {
  defaultProfiles,
  placement,
  importedProfile,
  profileCapabilities,
} from "./profiles.js";
import { modelConfiguration } from "./model.js";
import { targetMatches } from "./executor.js";
import { snapshotGitHub } from "./github.js";
import { command } from "./process.js";
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function createApp(
  store = new Store(),
  worker = new Worker(store),
  token = workspaceToken(),
) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
  });
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; expires: number }>();
  let capabilities: any;
  const getRun = (id: string) => {
    const r = store.get<Run>("run", id);
    if (!r)
      throw Object.assign(new Error("Run does not exist."), {
        statusCode: 404,
      });
    return r;
  };
  const key = (request: any) => {
    const k = request.headers["idempotency-key"];
    if (typeof k !== "string" || k.length < 8 || k.length > 200)
      throw new Error("An idempotency key is required.");
    return k;
  };
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) return;
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin) {
      const allowed = new Set(
        [
          `http://127.0.0.1:${process.env.WEB_PORT || 4183}`,
          `http://127.0.0.1:${process.env.API_PORT || 4184}`,
          process.env.MIRAGE_PUBLIC_ORIGIN,
        ].filter(Boolean),
      );
      if (!allowed.has(req.headers.origin))
        return reply
          .code(403)
          .send({ error: "Request origin is not allowed." });
    }
    if (url === "/api/session" && req.method === "POST") return;
    const cookie = req.headers.cookie?.match(
      /(?:^|;\s*)mirage_session=([a-f0-9]+)/,
    )?.[1];
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (
      !(bearer && equal(bearer, token)) &&
      !(cookie && (sessions.get(cookie) || 0) > Date.now())
    )
      return reply.code(401).send({ error: "Sign in to this workspace." });
  });
  app.setErrorHandler((e: any, _req, reply) =>
    reply.code(e instanceof ZodError ? 400 : e.statusCode || 400).send({
      error:
        e instanceof ZodError
          ? e.issues
              .map((x: any) => `${x.path.join(".")}: ${x.message}`)
              .join("; ")
          : e.message || "Request failed.",
    }),
  );
  app.post("/api/session", async (req, reply) => {
    const ip = req.ip;
    const current = attempts.get(ip) || {
      count: 0,
      expires: Date.now() + 60000,
    };
    if (current.expires < Date.now()) {
      current.count = 0;
      current.expires = Date.now() + 60000;
    }
    current.count++;
    attempts.set(ip, current);
    if (current.count > 10)
      return reply
        .code(429)
        .send({ error: "Too many sign-in attempts. Retry in one minute." });
    const body = z.object({ token: z.string().max(200) }).parse(req.body);
    if (!equal(body.token, token))
      return reply.code(401).send({ error: "The access code is not correct." });
    const session = randomBytes(24).toString("hex");
    sessions.set(session, Date.now() + 8 * 3600000);
    reply.header(
      "Set-Cookie",
      `mirage_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.MIRAGE_PUBLIC_ORIGIN?.startsWith("https:") ? "; Secure" : ""}`,
    );
    store.audit("sign-in", "demo-workspace");
    return { ok: true };
  });
  app.delete("/api/session", async (req, reply) => {
    const cookie = req.headers.cookie?.match(/mirage_session=([a-f0-9]+)/)?.[1];
    if (cookie) sessions.delete(cookie);
    reply.header(
      "Set-Cookie",
      "mirage_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { ok: true };
  });
  app.get("/api/capabilities", async () => {
    capabilities = await worker.engine.capabilities();
    const m = modelConfiguration();
    return {
      ...capabilities,
      model: { configured: m.configured, id: m.model || null },
      profiles: defaultProfiles(),
      repositoryExecution: false,
      retentionDays: Number(process.env.MIRAGE_RETENTION_DAYS || 7),
      trainingUse: false,
    };
  });
  app.get("/api/projects", async () => store.list("project"));
  app.get("/api/runtime", async () => {
    const directory = resolve(root, "neural-runtime", "artifacts");
    const read = async (name: string) => {
      try {
        return JSON.parse(await readFile(resolve(directory, name), "utf8"));
      } catch {
        return null;
      }
    };
    const [demo, generation, training, packaged, optimization] =
      await Promise.all([
        read("demo-report.json"),
        read("generation-report.json"),
        read("model/training.json"),
        read("package-report.json"),
        read("optimization/report.json"),
      ]);
    return {
      demo,
      generation,
      training,
      packaged,
      optimization:
        optimization?.trials?.length &&
        optimization.trials.every(
          (trial: any) =>
            trial.model_checkpoint_sha256 === generation?.checkpoint_sha256,
        )
          ? {
              summary: optimization.summary,
              repeats: optimization.repeats,
              protocol: optimization.protocol,
              caveats: optimization.caveats,
            }
          : null,
    };
  });
  let runtimeBusy = false;
  app.post("/api/runtime/demo", async (request) => {
    const body = z
      .object({ seed: z.number().int().min(1).max(10000000).default(100000) })
      .strict()
      .parse(request.body);
    return store.idempotentAsync(key(request), { runtime: body }, async () => {
      if (runtimeBusy || worker.active)
        throw Object.assign(
          new Error("A runtime demonstration is already active."),
          { statusCode: 409 },
        );
      runtimeBusy = true;
      worker.externalBusy = true;
      try {
        const directory = resolve(root, "neural-runtime");
        const result = await command(
          resolve(directory, ".venv/bin/python"),
          [
            "demo.py",
            "--json",
            "--no-save",
            "--seed",
            String(body.seed),
            "--count",
            "300",
            "--rounds",
            "3",
          ],
          { cwd: directory, timeoutMs: 30000 },
        );
        if (result.code !== 0)
          throw new Error(`Runtime demonstration failed: ${result.stderr}`);
        const report = {
          ...JSON.parse(result.stdout),
          execution: "live",
          requestedSeed: body.seed,
          recordedAt: new Date().toISOString(),
        };
        const artifactId = store.artifact(
          "workspace",
          "runtime-evidence.json",
          JSON.stringify(report, null, 2),
          "application/json",
        );
        store.audit("runtime-execution", artifactId);
        return { ...report, artifactId };
      } finally {
        runtimeBusy = false;
        worker.externalBusy = false;
      }
    });
  });
  app.get("/api/runtime/package", async (_request, reply) => {
    const bytes = await readFile(
      resolve(root, "neural-runtime/artifacts/mirage-neural-runtime.tar.gz"),
    );
    return reply
      .header(
        "Content-Disposition",
        'attachment; filename="mirage-neural-runtime.tar.gz"',
      )
      .type("application/gzip")
      .send(bytes);
  });
  app.post("/api/projects", async (req) => {
    const b = z
      .object({
        name: z.string().min(1).max(100),
        source: z.enum(["sample", "github"]),
        url: z.string().max(500).optional(),
        revision: z.string().max(100).default("HEAD"),
      })
      .strict()
      .parse(req.body);
    const k = key(req);
    const previous = store.db
      .prepare("SELECT fingerprint,result FROM requests WHERE key=?")
      .get(k) as any;
    if (previous) {
      if (previous.fingerprint !== jsonHash(b))
        throw new Error("Idempotency key conflict.");
      return JSON.parse(previous.result);
    }
    return store.idempotentAsync(k, b, async () => {
      const snapshot =
        b.source === "github"
          ? await snapshotGitHub(b.url || "", b.revision)
          : {
              kind: "included-fictional-sample",
              sourceHash: hash(original),
              files: [
                {
                  path: "calibrate.c",
                  sha256: hash(original),
                  content: Buffer.from(original).toString("base64"),
                },
                {
                  path: "runner.c",
                  sha256: hash(runner),
                  content: Buffer.from(runner).toString("base64"),
                },
              ],
              dependencies: ["C11 standard library"],
              executionSupported: true,
            };
      const { files, ...metadata } = snapshot;
      const artifactId = store.artifact(
        "workspace",
        "source-snapshot.json",
        JSON.stringify(snapshot, null, 2),
        "application/json",
      );
      const p = {
        id: randomUUID(),
        ...b,
        snapshot: { ...metadata, artifactId },
        createdAt: new Date().toISOString(),
      };
      store.put("project", p.id, p);
      store.audit("project-created", p.id);
      return p;
    });
  });
  app.get("/api/profiles", async () => store.list("profile"));
  app.post("/api/profiles", async (req) => {
    const profile = importedProfile(req.body);
    return store.idempotent(key(req), { profile }, () => {
      const record = {
        id: randomUUID(),
        profile,
        hash: jsonHash(profile),
        createdAt: new Date().toISOString(),
      };
      store.put("profile", record.id, record);
      store.audit("profile-imported", record.id);
      return record;
    });
  });
  app.post("/api/profiles/validate", async (req) => {
    key(req);
    const profile = importedProfile(req.body);
    const caps = await worker.engine.capabilities();
    const support = profileCapabilities(
      profile,
      worker.engine.kind,
      caps.target,
    );
    if (!caps.compiler) support.gaps.push("The compiler is unavailable.");
    if (!caps.proof)
      support.gaps.push("The formal verification tools are unavailable.");
    if (
      worker.engine.kind === "hosted" &&
      !/^sha256:[a-f0-9]{64}$/.test(caps.imageDigest || "")
    )
      support.gaps.push("The hosted worker has no exact image digest.");
    support.supported = support.gaps.length === 0;
    return {
      profile,
      hash: jsonHash(profile),
      ...support,
      placement: placement(profile),
    };
  });
  app.post("/api/attachments", async (req) => {
    const b = z
      .object({
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w .-]+$/),
        content: z.string().max(1400000),
      })
      .strict()
      .parse(req.body);
    const bytes = Buffer.from(b.content, "base64");
    if (bytes.length > 1048576) throw new Error("Attachment exceeds 1 MiB.");
    return store.idempotent(key(req), b, () => {
      const id = store.artifact("workspace", b.name, bytes);
      const record = {
        id,
        name: b.name,
        sha256: hash(bytes),
        bytes: bytes.length,
        review: "unreviewed",
        execution: "never executed",
      };
      store.put("attachment", id, record);
      store.audit("attachment-upload", id);
      return record;
    });
  });
  app.get("/api/attachments", async () => store.list("attachment"));
  app.get("/api/runs", async () =>
    store.list<Run>("run").map((r) => ({
      ...r,
      baseline: r.baseline ? { target: r.baseline.target } : undefined,
      candidates: r.candidates.map((c) => ({
        ...c,
        source: undefined,
        proof: c.proof ? { ...c.proof, log: undefined } : undefined,
      })),
    })),
  );
  app.post("/api/runs", async (req) => {
    const b = z
      .object({
        projectId: z.string().uuid(),
        profile: profileSchema,
        policy: policySchema,
        attachmentIds: z.array(z.string().uuid()).max(20).default([]),
      })
      .strict()
      .parse(req.body);
    b.profile = importedProfile(b.profile);
    const project = store.get<any>("project", b.projectId);
    if (!project) throw new Error("Project does not exist.");
    if (project.source !== "sample")
      throw new Error(
        "Arbitrary repository execution is disabled until a reviewed isolation and build adapter is available.",
      );
    if (b.attachmentIds.some((id) => !store.get("attachment", id)))
      throw new Error("Attachment does not exist.");
    const caps = await worker.engine.capabilities();
    const support = profileCapabilities(
      b.profile,
      worker.engine.kind,
      caps.target,
    );
    if (!caps.compiler) support.gaps.push("The compiler is unavailable.");
    if (!caps.proof)
      support.gaps.push("The formal verification tools are unavailable.");
    if (
      worker.engine.kind === "hosted" &&
      !/^sha256:[a-f0-9]{64}$/.test(caps.imageDigest || "")
    )
      support.gaps.push("The hosted worker has no exact image digest.");
    if (support.gaps.length) throw new Error(support.gaps.join(" "));
    if (b.profile.supportingFileIds.some((id) => !b.attachmentIds.includes(id)))
      throw new Error(
        "Every profile supporting file must be attached to this run.",
      );
    if (b.policy.exclusions.includes("calibrate"))
      throw new Error("The protected function is also excluded.");
    if (
      (b.policy.mode === "model" || b.policy.analyst === "model") &&
      !b.policy.allowSourceDisclosure
    )
      throw new Error(
        "Model proposals require explicit source disclosure permission.",
      );
    if (
      (b.policy.mode === "model" || b.policy.analyst === "model") &&
      !modelConfiguration().configured
    )
      throw new Error(
        "Live model access is not configured. Choose catalog mode for the local demonstration.",
      );
    return store.idempotent(key(req), b, () => {
      if (
        store.list<Run>("run").filter((r) => !terminal.has(r.state)).length >=
        20
      )
        throw new Error("The queue is full.");
      const r: Run = {
        id: randomUUID(),
        projectId: project.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "queued",
        profile: b.profile,
        policy: b.policy,
        sourceHash: hash(original),
        profileHash: jsonHash(b.profile),
        policyHash: jsonHash(b.policy),
        candidates: [],
        artifacts: {},
        cancelRequested: false,
        modelUsage: { tokens: 0, costUsd: 0 },
        gaps: [],
      };
      store.saveRun(r);
      store.put("run-attachments", r.id, b.attachmentIds);
      store.event(r, "queued", "Run queued with frozen inputs and limits.");
      store.audit("run-created", r.id);
      return r;
    });
  });
  app.delete("/api/runs/:id", async (req: any) => {
    const result = store.idempotent(
      key(req),
      { deleteRun: req.params.id },
      () => {
        store.deleteRun(req.params.id);
        return { deleted: true };
      },
    );
    store.collectArtifacts();
    return result;
  });
  app.get("/api/runs/:id", async (req: any) => getRun(req.params.id));
  app.post("/api/runs/:id/cancel", async (req: any) =>
    store.idempotent(key(req), { cancel: req.params.id }, () =>
      worker.cancel(req.params.id),
    ),
  );
  app.get("/api/runs/:id/events", async (req: any, reply) => {
    getRun(req.params.id);
    let after = Number(req.headers["last-event-id"] || req.query.after || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Invalid event sequence.");
    if (req.query.format === "json") return store.events(req.params.id, after);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let replay = true;
    const send = () => {
      for (const e of store.events(req.params.id, after)) {
        reply.raw.write(
          `id: ${e.sequence}\ndata: ${JSON.stringify({ ...e, replay })}\n\n`,
        );
        after = e.sequence;
      }
    };
    send();
    replay = false;
    const timer = setInterval(() => {
      if (reply.raw.writableLength > 1024 * 1024) {
        reply.raw.end();
        return;
      }
      send();
      reply.raw.write(": keepalive\n\n");
    }, 700);
    req.raw.on("close", () => {
      clearInterval(timer);
      streams.delete(reply.raw);
    });
  });
  app.get("/api/runs/:id/candidates/:candidateId", async (req: any) => {
    const c = getRun(req.params.id).candidates.find(
      (x) => x.id === req.params.candidateId,
    );
    if (!c)
      throw Object.assign(new Error("Candidate does not exist."), {
        statusCode: 404,
      });
    return c;
  });
  app.post("/api/runs/:id/calculate", async (req: any) => {
    const requestKey = key(req);
    const r = getRun(req.params.id),
      input = inputSchema.parse(req.body);
    return store.idempotentAsync(
      requestKey,
      { calculate: r.id, input },
      async () => {
        if (!r.baseline) throw new Error("Baseline is not ready.");
        const c = r.candidates.find((x) => x.id === r.acceptedId);
        const args = [[input.raw, input.gain_q8, input.offset]];
        const dir = resolve(
          store.directory,
          "work",
          r.id,
          "live",
          randomUUID(),
        );
        const a = await worker.engine.execute(
          store.artifactBytes(r.baseline.artifacts.binary),
          resolve(dir, "original"),
          args,
        );
        const b = await worker.engine.execute(
          store.artifactBytes(
            c?.artifacts.binary || r.baseline.artifacts.binary,
          ),
          resolve(dir, "protected"),
          args,
        );
        store.audit("live-comparison", r.id);
        return {
          input,
          original: a[0],
          protected: b[0],
          matches: a[0] === b[0],
          mode: c ? "original-versus-protected" : "original-versus-original",
          binaryHash: c?.binaryHash || r.baseline.binaryHash,
        };
      },
    );
  });
  app.get("/api/artifacts/:id", async (req: any, reply) => {
    const a = store.artifactInfo(req.params.id);
    if (!a || (a.run_id !== "workspace" && !store.get("run", a.run_id)))
      return reply.code(404).send({ error: "Artifact does not exist." });
    store.audit("artifact-download", a.id);
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="${a.name.replace(/[^\w.-]/g, "_")}"`,
      )
      .header("X-Artifact-SHA256", a.digest)
      .type(a.mime)
      .send(store.artifactBytes(a.id));
  });
  app.get("/*", async (req, reply) => {
    const pathname = req.url.split("?")[0];
    if (pathname.startsWith("/api"))
      return reply.code(404).send({ error: "Route does not exist." });
    if (pathname !== "/" && !/^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname))
      return reply.code(404).send("Not found");
    const file = resolve(
      root,
      "dist/web",
      pathname === "/" ? "index.html" : pathname.slice(1),
    );
    try {
      return reply
        .type(
          (
            {
              ".js": "application/javascript",
              ".css": "text/css",
              ".html": "text/html",
            } as any
          )[extname(file)] || "application/octet-stream",
        )
        .send(await readFile(file));
    } catch {
      return reply
        .code(404)
        .send("Build the frontend with npm run build, or use npm run dev.");
    }
  });
  return { app, store, worker };
}
