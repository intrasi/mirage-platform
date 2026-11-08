import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../server/store.js";
import { Worker } from "../server/worker.js";
import { createApp } from "../server/app.js";
import {
  defaultProfiles,
  importedProfile,
  profileCapabilities,
} from "../server/profiles.js";
import { snapshotGitHub } from "../server/github.js";
import { hash } from "../server/config.js";
import { command } from "../server/process.js";
import { original } from "../server/sample.js";
import type { Run } from "../shared/schema.js";

test("source intake validates every blob and rejects submodules and tampered content", async () => {
  const content = '{"dependencies":{"a":"1.0"}}';
  const sha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");
  const entry = {
    type: "blob",
    path: "package.json",
    mode: "100644",
    sha,
    size: Buffer.byteLength(content),
  };
  const transport = (entries: any[], data = content) =>
    (async (url: any) =>
      new Response(
        JSON.stringify(
          String(url).includes("/commits/")
            ? { sha: "a".repeat(40) }
            : String(url).includes("/git/blobs/")
              ? {
                  sha,
                  encoding: "base64",
                  content: Buffer.from(data).toString("base64"),
                }
              : { sha: "b".repeat(40), tree: entries, truncated: false },
        ),
      )) as typeof fetch;
  const snapshot = await snapshotGitHub(
    "https://github.com/test/sample",
    "main",
    transport([entry]),
  );
  assert.equal(snapshot.dependencies[0].sha256, hash(content));
  assert.equal(snapshot.dependencies[0].path, "package.json");
  await assert.rejects(
    snapshotGitHub(
      "https://github.com/test/sample",
      "main",
      transport([entry], content.replace("a", "b")),
    ),
    /identity mismatch/,
  );
  await assert.rejects(
    snapshotGitHub(
      "https://github.com/test/sample",
      "main",
      transport([{ ...entry, type: "commit", mode: "160000" }]),
    ),
    /paths or links/,
  );
  await assert.rejects(
    snapshotGitHub(
      "https://github.com/test/sample",
      "main",
      transport([entry, entry]),
    ),
    /paths or links/,
  );
});

test("device requirements fail closed and uploaded fields cannot claim verification", () => {
  const profile = defaultProfiles()[0];
  const target = `${process.platform}-${process.arch}`;
  assert.equal(
    profileCapabilities(profile, "trusted-local", target).supported,
    true,
  );
  for (const extra of [
    { modelPolicy: "required" },
    { maxEnergyMillijoules: 1 },
    { stackLimitBytes: 4096 },
    { peripherals: ["watchdog"] },
    { toolchain: "unknown" },
    { abi: undefined },
  ])
    assert.equal(
      profileCapabilities(
        { ...profile, ...extra } as any,
        "trusted-local",
        target,
      ).supported,
      false,
    );
  const uploaded = importedProfile(profile);
  assert.ok(Object.keys(uploaded.provenance).includes("ramMiB"));
  assert.ok(
    Object.values(uploaded.provenance).every((p) => p.review === "unreviewed"),
  );
});

test("asynchronous idempotency executes once and rejects changed input", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-idempotency-"));
  const store = new Store(resolve(dir, "db"));
  try {
    let calls = 0;
    const work = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { calls };
    };
    const first = store.idempotentAsync("same-key", { seed: 1 }, work);
    const repeat = store.idempotentAsync("same-key", { seed: 1 }, work);
    await assert.rejects(
      store.idempotentAsync("same-key", { seed: 2 }, work),
      /conflict/,
    );
    assert.deepEqual(await first, await repeat);
    assert.equal(calls, 1);
    assert.deepEqual(
      await store.idempotentAsync("same-key", { seed: 1 }, work),
      { calls: 1 },
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejected candidates return a real unchanged baseline and complete private evidence", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-baseline-return-"));
  const store = new Store(resolve(dir, "db")),
    worker = new Worker(store);
  const { app } = createApp(store, worker, "completion-token");
  let sequence = 0;
  const headers = () => ({
    authorization: "Bearer completion-token",
    "idempotency-key": `completion-${++sequence}`,
  });
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: headers(),
        payload: { name: "Baseline return", source: "sample" },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: headers(),
      payload: {
        projectId: project.id,
        profile: { ...defaultProfiles()[0], maxSlowdown: 0.01 },
        policy: { maxAttempts: 4, maxRepeatedFailures: 1 },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().id;
    await worker.tick();
    const run = store.get<Run>("run", id)!;
    assert.equal(run.state, "succeeded", run.error);
    assert.equal(run.outcome, "unchanged-baseline");
    assert.equal(run.acceptedId, undefined);
    assert.match(run.stopReason!, /Repeated/);
    assert.equal(
      run.candidates.filter((c) => c.origin === "catalog").length,
      1,
    );
    assert.equal(run.baseline!.proof.state, "proved");
    assert.ok(run.toolRecords!.length >= 5);
    const manifest = JSON.parse(
      store.artifactBytes(run.artifacts.manifest).toString(),
    );
    assert.equal(manifest.outcome, "unchanged-baseline");
    assert.equal(manifest.binaryHash, run.baseline!.binaryHash);
    assert.deepEqual(manifest.changedFunctions, []);
    assert.match(
      store.artifactBytes(run.artifacts.report).toString(),
      /No transformation passed/,
    );
    for (const name of ["source", "executable", "developer"]) {
      const out = resolve(dir, name);
      await mkdir(out);
      const archive = resolve(dir, `${name}.tar.gz`);
      await writeFile(archive, store.artifactBytes(run.artifacts[name]));
      assert.equal(
        (await command("tar", ["-xzf", archive, "-C", out])).code,
        0,
      );
      if (name === "source")
        assert.equal(
          await readFile(resolve(out, "calibrate.c"), "utf8"),
          original,
        );
      if (name === "executable") {
        assert.equal(
          (
            await command(resolve(out, "calculator"), [], {
              input: "812 300 -21\n",
            })
          ).stdout.trim(),
          "931",
        );
        assert.deepEqual((await readdir(out)).sort(), [
          "README.txt",
          "calculator",
          "manifest.json",
        ]);
      }
      if (name === "developer") {
        const evidence = JSON.parse(
          await readFile(resolve(out, "evidence.json"), "utf8"),
        );
        assert.equal(evidence.run.id, id);
        const index = JSON.parse(
          await readFile(resolve(out, "artifact-index.json"), "utf8"),
        );
        for (const artifact of index)
          assert.equal(
            hash(await readFile(resolve(out, artifact.id))),
            artifact.digest,
          );
      }
    }
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/runs/${id}`,
      headers: headers(),
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(store.get("run", id), undefined);
    assert.equal(store.artifactInfo(run.artifacts.executable), undefined);
  } finally {
    await worker.stop();
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
