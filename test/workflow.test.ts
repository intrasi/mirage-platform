import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store } from "../server/store.js";
import { Worker } from "../server/worker.js";
import { createApp } from "../server/app.js";
import { defaultProfiles } from "../server/profiles.js";
import { hash } from "../server/config.js";
import { command } from "../server/process.js";
import { original } from "../server/sample.js";
import { LocalExecutor } from "../server/executor.js";
import type { Run } from "../shared/schema.js";
test("full API workflow exports matching source and executable manifests and runs fresh inputs", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-flow-"));
  const store = new Store(resolve(dir, "db"));
  const worker = new Worker(store);
  const { app } = createApp(store, worker, "workflow-token");
  let sequence = 0;
  const headers = () => ({
    authorization: "Bearer workflow-token",
    "idempotency-key": `workflow-${++sequence}`,
  });
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: headers(),
        payload: { name: "Workflow sample", source: "sample" },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: headers(),
      payload: {
        projectId: project.id,
        profile: defaultProfiles()[0],
        policy: { maxAttempts: 1 },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().id;
    await worker.tick();
    const run = store.get<Run>("run", id)!;
    assert.equal(run.state, "succeeded", run.error);
    const best = run.candidates.find((c) => c.id === run.acceptedId)!;
    assert.equal(best.proof?.state, "proved");
    assert.equal(
      run.candidates.find((c) => c.origin === "injected-control")?.proof?.state,
      "counterexample",
    );
    const calc = await app.inject({
      method: "POST",
      url: `/api/runs/${id}/calculate`,
      headers: headers(),
      payload: { raw: 812, gain_q8: 300, offset: -21 },
    });
    assert.equal(calc.statusCode, 200, calc.body);
    assert.equal(calc.json().original, 931);
    assert.equal(calc.json().protected, 931);
    assert.equal(calc.json().binaryHash, best.binaryHash);
    const manifests = [];
    for (const kind of ["source", "executable"]) {
      const download = await app.inject({
        method: "GET",
        url: `/api/artifacts/${run.artifacts[kind]}`,
        headers: headers(),
      });
      assert.equal(download.statusCode, 200);
      assert.equal(
        hash(download.rawPayload),
        download.headers["x-artifact-sha256"],
      );
      const destination = resolve(dir, kind);
      await mkdir(destination);
      const archive = resolve(dir, `${kind}.tar.gz`);
      await writeFile(archive, download.rawPayload);
      const extract = await command("tar", [
        "-xzf",
        archive,
        "-C",
        destination,
      ]);
      assert.equal(extract.code, 0);
      const manifest = JSON.parse(
        await readFile(resolve(destination, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.candidateId, best.id);
      assert.equal(manifest.binaryHash, best.binaryHash);
      manifests.push(manifest);
      if (kind === "executable") {
        assert.equal(
          hash(await readFile(resolve(destination, "calculator"))),
          best.binaryHash,
        );
        const executed = await command(resolve(destination, "calculator"), [], {
          input: "1 128 0\n",
        });
        assert.equal(executed.stdout.trim(), "1");
      } else
        assert.equal(
          hash(await readFile(resolve(destination, "calibrate.c"))),
          best.sourceHash,
        );
    }
    assert.deepEqual(manifests[0], manifests[1]);
    const last = store.events(id).at(-1)!;
    assert.equal(last.stage, "succeeded");
    const after = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${id}/events?format=json&after=${last.sequence - 1}`,
        headers: headers(),
      })
    ).json();
    assert.equal(after.length, 1);
    assert.equal(after[0].sequence, last.sequence);
  } finally {
    await worker.stop();
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("active cancellation preserves events and prevents successful packaging", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-cancel-"));
  const store = new Store(resolve(dir, "db"));
  const worker = new Worker(store);
  const { app } = createApp(store, worker, "cancel-token");
  const h = {
    authorization: "Bearer cancel-token",
    "idempotency-key": "cancel-project",
  };
  try {
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: h,
        payload: { name: "Cancellation", source: "sample" },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { ...h, "idempotency-key": "cancel-run" },
      payload: {
        projectId: p.id,
        profile: defaultProfiles()[0],
        policy: { maxAttempts: 12 },
      },
    });
    const id = response.json().id;
    const task = worker.tick();
    await new Promise((r) => setTimeout(r, 25));
    worker.cancel(id);
    await task;
    const r = store.get<Run>("run", id)!;
    assert.equal(r.state, "cancelled");
    assert.equal(r.cancelRequested, true);
    assert.equal(r.artifacts.executable, undefined);
    assert.ok(store.events(id).some((e) => e.stage === "cancellation"));
  } finally {
    await worker.stop();
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker restart retains baseline evidence and resumes incomplete verification", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-recovery-"));
  let store = new Store(resolve(dir, "db"));
  const engine = new LocalExecutor();
  const realProve = engine.prove.bind(engine);
  engine.prove = async (_source, _dir, signal) =>
    _source === original
      ? realProve(_source, _dir, signal)
      : new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Interrupted fixture tool.")),
            { once: true },
          );
        });
  const first = new Worker(store, engine);
  const { app } = createApp(store, first, "recovery-token");
  const headers = {
    authorization: "Bearer recovery-token",
    "idempotency-key": "recovery-project",
  };
  let second: Worker | undefined;
  try {
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "Recovery", source: "sample" },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { ...headers, "idempotency-key": "recovery-run" },
      payload: {
        projectId: p.id,
        profile: defaultProfiles()[0],
        policy: { maxAttempts: 1 },
      },
    });
    const id = response.json().id;
    const processing = first.tick();
    const deadline = Date.now() + 10000;
    while (!store.get<Run>("run", id)?.candidates.length) {
      if (Date.now() > deadline)
        throw new Error("Recovery fixture did not reach verification.");
      await new Promise((r) => setTimeout(r, 10));
    }
    const baselineHash = store.get<Run>("run", id)!.baseline!.binaryHash;
    await first.stop();
    await processing;
    await app.close();
    store.close();
    store = new Store(resolve(dir, "db"));
    second = new Worker(store);
    await second.tick();
    const resumed = store.get<Run>("run", id)!;
    assert.equal(resumed.state, "succeeded", resumed.error);
    assert.equal(resumed.baseline!.binaryHash, baselineHash);
    assert.ok(resumed.candidates.some((c) => c.reason.includes("Interrupted")));
    assert.ok(store.events(id).some((e) => e.stage === "recovery"));
    assert.ok((resumed.elapsedMs || 0) > 0);
  } finally {
    await first.stop();
    await second?.stop();
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retention removes expired runs while preserving artifacts shared with active runs", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-retention-"));
  const store = new Store(resolve(dir, "db"));
  try {
    const old = {
      id: "old",
      state: "failed",
      updatedAt: "2000-01-01T00:00:00Z",
    } as Run;
    const active = {
      id: "active",
      state: "verifying",
      updatedAt: "2000-01-01T00:00:00Z",
    } as Run;
    store.put("run", "old", old);
    store.put("run", "active", active);
    const expired = store.artifact("old", "old.txt", "shared content");
    const retained = store.artifact("active", "active.txt", "shared content");
    store.prune(7);
    assert.equal(store.get("run", "old"), undefined);
    assert.ok(store.get("run", "active"));
    assert.equal(store.artifactInfo(expired), undefined);
    assert.equal(store.artifactBytes(retained).toString(), "shared content");
    assert.throws(() => store.prune(0), /positive/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
