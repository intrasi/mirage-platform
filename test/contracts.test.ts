import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  profileSchema,
  policySchema,
  proposalSchema,
  inputSchema,
} from "../shared/schema.js";
import { Store } from "../server/store.js";
import { createApp } from "../server/app.js";
import { Worker } from "../server/worker.js";
import {
  parseGitHub,
  safeRepositoryPath,
  snapshotGitHub,
} from "../server/github.js";
import { defaultProfiles } from "../server/profiles.js";
import { HostedExecutor } from "../server/executor.js";
import { reconstruct } from "../server/reconstruction.js";
import { hash } from "../server/config.js";

test("contracts reject out-of-domain data, extra properties, and excessive budgets", () => {
  for (const x of [
    { raw: 4096, gain_q8: 256, offset: 0 },
    { raw: 1, gain_q8: 0, offset: 0 },
    { raw: 1.5, gain_q8: 1, offset: 0 },
    { raw: 1, gain_q8: 1, offset: -1025 },
  ])
    assert.equal(inputSchema.safeParse(x).success, false);
  for (const p of [
    { maxAttempts: 13 },
    { maxCostUsd: 6 },
    { maxSeconds: 901 },
    { maxTokens: 100001 },
    { proofRequired: false },
  ])
    assert.equal(policySchema.safeParse(p).success, false);
  assert.equal(
    proposalSchema.safeParse({ transform: "shell", key: 1, reason: "run code" })
      .success,
    false,
  );
  assert.equal(
    profileSchema.safeParse({ ...defaultProfiles()[0], ramMiB: 0 }).success,
    false,
  );
});
test("GitHub intake restricts host, revision paths, symlinks, and repository size", async () => {
  assert.deepEqual(parseGitHub("https://github.com/aster/calibration.git"), {
    owner: "aster",
    repo: "calibration",
  });
  for (const u of [
    "http://github.com/a/b",
    "https://127.0.0.1/a/b",
    "https://github.com.evil.test/a/b",
    "https://user@github.com/a/b",
    "https://github.com/a/b/tree/main",
    "https://github.com:444/a/b",
  ])
    assert.throws(() => parseGitHub(u));
  for (const p of [
    "../outside",
    "/absolute",
    "a/../../b",
    "a\\b",
    ".git/config",
  ])
    assert.equal(safeRepositoryPath(p), false);
  const blob = "x".repeat(100);
  const blobSha = createHash("sha1").update(`blob 100\0${blob}`).digest("hex");
  const mock = (tree: any) => async (url: any) =>
    new Response(
      JSON.stringify(
        String(url).includes("/commits/")
          ? { sha: "a".repeat(40) }
          : String(url).includes("/git/blobs/")
            ? {
                sha: blobSha,
                encoding: "base64",
                content: Buffer.from(blob).toString("base64"),
              }
            : { tree, truncated: false, sha: "b".repeat(40) },
      ),
    );
  const snapshot = await snapshotGitHub(
    "https://github.com/a/b",
    "HEAD",
    mock([
      {
        type: "blob",
        path: "calibrate.c",
        sha: blobSha,
        mode: "100644",
        size: 100,
      },
    ]) as typeof fetch,
  );
  assert.equal(snapshot.commit, "a".repeat(40));
  assert.equal(snapshot.executionSupported, false);
  assert.equal(
    Buffer.from(snapshot.files[0].content, "base64").toString(),
    blob,
  );
  assert.equal(snapshot.files[0].sha256, hash(blob));
  await assert.rejects(
    snapshotGitHub(
      "https://github.com/a/b",
      "HEAD",
      mock([
        { type: "blob", path: "link", mode: "120000", size: 1 },
      ]) as typeof fetch,
    ),
    /paths or links/,
  );
  await assert.rejects(
    snapshotGitHub(
      "https://github.com/a/b",
      "HEAD",
      mock([
        { type: "blob", path: "big", mode: "100644", size: 11000000 },
      ]) as typeof fetch,
    ),
    /10 MiB/,
  );
});
test("records, events, idempotency conflicts, and worker leases survive restart", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-store-"));
  let store = new Store(resolve(dir, "db"));
  try {
    store.put("project", "p", { name: "Aster" });
    assert.deepEqual(
      store.idempotent("request-1", { a: 1 }, () => ({ result: 1 })),
      { result: 1 },
    );
    assert.deepEqual(
      store.idempotent("request-1", { a: 1 }, () => ({ result: 2 })),
      { result: 1 },
    );
    assert.throws(
      () => store.idempotent("request-1", { a: 2 }, () => null),
      /different input/,
    );
    const run = { id: "r" } as any;
    store.event(run, "queued", "one");
    store.event(run, "proof", "two");
    assert.equal(store.acquire("a"), true);
    assert.equal(store.acquire("b"), false);
    store.close();
    store = new Store(resolve(dir, "db"));
    assert.equal(store.get<any>("project", "p").name, "Aster");
    assert.deepEqual(
      store.events("r", 1).map((e) => e.sequence),
      [2],
    );
    store.db.prepare("UPDATE lease SET expires=0").run();
    assert.equal(store.acquire("b"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("private API enforces authentication, immutable run policy, idempotency, target gaps, and cancellation", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-api-"));
  const store = new Store(resolve(dir, "db"));
  const worker = new Worker(store);
  const { app } = createApp(store, worker, "test-workspace-token");
  const headers = {
    authorization: "Bearer test-workspace-token",
    "idempotency-key": "request-project",
  };
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/runs" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/session",
          payload: { token: "wrong" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/session",
          headers: { origin: "https://untrusted.test" },
          payload: { token: "test-workspace-token" },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { token: "test-workspace-token" },
    });
    assert.equal(login.statusCode, 200);
    assert.match(
      String(login.headers["set-cookie"]),
      /HttpOnly; SameSite=Strict/,
    );
    const payload = { name: "Aster", source: "sample" };
    const a = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload,
    });
    assert.equal(a.statusCode, 200);
    assert.equal(a.json().id, b.json().id);
    const req = {
      method: "POST" as const,
      url: "/api/runs",
      headers: { ...headers, "idempotency-key": "request-run" },
      payload: {
        projectId: a.json().id,
        profile: defaultProfiles()[0],
        policy: { maxAttempts: 1 },
      },
    };
    const created = await app.inject(req);
    assert.equal(created.statusCode, 200, created.body);
    const run = created.json();
    assert.equal((await app.inject(req)).json().id, run.id);
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/cancel`,
      headers: { ...headers, "idempotency-key": "request-cancel" },
      payload: {},
    });
    assert.equal(cancelled.json().state, "cancelled");
    assert.equal(store.events(run.id).length, 2);
    const invalid = await app.inject({
      ...req,
      headers: { ...headers, "idempotency-key": "invalid-run" },
      payload: { ...req.payload, profile: defaultProfiles()[2] },
    });
    assert.equal(invalid.statusCode, 400);
    const artifact = store.artifact(
      run.id,
      "private.txt",
      "private evidence",
      "text/plain",
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/artifacts/${artifact}` }))
        .statusCode,
      401,
    );
    const download = await app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact}`,
      headers,
    });
    assert.equal(download.body, "private evidence");
    assert.equal(
      download.headers["x-artifact-sha256"],
      hash("private evidence"),
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/artifacts/../../etc/passwd",
          headers,
        })
      ).statusCode,
      404,
    );
    const invalidInputs = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/calculate`,
      headers,
      payload: { raw: 5000, gain_q8: 1, offset: 0 },
    });
    assert.equal(invalidInputs.statusCode, 400);
  } finally {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("hosted adapter requires TLS and rejects mismatched proof identities", async () => {
  assert.throws(
    () => new HostedExecutor("http://worker.test", "token"),
    /HTTPS/,
  );
  const e = new HostedExecutor("https://worker.test", "token");
  e.request = async () => ({
    state: "proved",
    sourceHash: "wrong",
    harnessHash: "wrong",
  });
  await assert.rejects(e.prove("source", "unused"), /identity mismatch/);
});
test("reconstruction freezes a real hypothesis before generating judge cases", async () => {
  const result = await reconstruct("artifact", async (xs) =>
    xs.map(([r, g, o]) =>
      Math.max(0, Math.min(4095, Math.floor((r * g + 128) / 256) + o)),
    ),
  );
  assert.equal(result.recovered, true);
  assert.equal(result.heldout.cases, 1240);
  assert.equal(result.heldout.generatedAfterFreeze, true);
  assert.equal(hash(result.frozenOutput), result.frozenHash);
});
