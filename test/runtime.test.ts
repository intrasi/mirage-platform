import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store } from "../server/store.js";
import { Worker } from "../server/worker.js";
import { createApp } from "../server/app.js";

test("runtime routes enforce authentication and execute the local model", async (t) => {
  try {
    await access(resolve("neural-runtime/artifacts/model/model.pt"));
  } catch {
    t.skip("Run runtime:setup and runtime:train first.");
    return;
  }
  const directory = await mkdtemp(resolve(tmpdir(), "mirage-runtime-"));
  const store = new Store(resolve(directory, "db"));
  const worker = new Worker(store);
  const { app } = createApp(store, worker, "runtime-test-token");
  const headers = {
    authorization: "Bearer runtime-test-token",
    "idempotency-key": "runtime-test-live",
  };
  try {
    assert.equal((await app.inject({ url: "/api/runtime" })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: "/api/runtime/package" })).statusCode,
      401,
    );
    const evidence = await app.inject({ url: "/api/runtime", headers });
    assert.equal(evidence.statusCode, 200);
    assert.equal(evidence.json().training.parameters, 764544);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/runtime/demo",
      headers,
      payload: { seed: -1 },
    });
    assert.equal(invalid.statusCode, 400);
    const live = await app.inject({
      method: "POST",
      url: "/api/runtime/demo",
      headers,
      payload: { seed: 100150 },
    });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().matching_calls, 1260);
    assert.ok(
      Object.values(live.json().attacks).every((attack: any) => attack.blocked),
    );
  } finally {
    await app.close();
    await worker.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
