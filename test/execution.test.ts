import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalExecutor,
  measure,
  functionAssembly,
} from "../server/executor.js";
import { original, incorrect, transform } from "../server/sample.js";
import { catalog } from "../server/model.js";
import { defaultProfiles } from "../server/profiles.js";
import { command } from "../server/process.js";
test("real compiler, complete proof domain, negative control, binary comparison, and resource gates", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "mirage-proof-"));
  const engine = new LocalExecutor();
  try {
    const caps = await engine.capabilities();
    assert.ok(caps.proof, "Install CBMC with npm run setup:proof.");
    const rejected = await engine.prove(incorrect, resolve(dir, "bad"));
    assert.equal(rejected.state, "counterexample", rejected.log);
    assert.match(rejected.log, /FAILURE/);
    const source = transform(catalog[0]);
    const proof = await engine.prove(source, resolve(dir, "good"));
    assert.equal(proof.state, "proved", proof.log);
    const baseline = await engine.build(
      original,
      resolve(dir, "baseline"),
      undefined,
      true,
    );
    const protectedBuild = await engine.build(
      source,
      resolve(dir, "protected"),
    );
    assert.ok(functionAssembly(protectedBuild.assembly));
    const measurement = measure(protectedBuild, baseline, defaultProfiles()[0]);
    assert.equal(measurement.matches, true);
    assert.equal(measurement.differentialCases, 10240);
    assert.equal(measurement.assemblyChanged, true);
    assert.equal(measurement.passed, true, JSON.stringify(measurement));
    assert.deepEqual(
      await engine.execute(protectedBuild.binary, resolve(dir, "live"), [
        [1000, 256, -10],
        [1, 128, 0],
        [4095, 1024, 1024],
      ]),
      [990, 1, 4095],
    );
    const strict = measure(protectedBuild, baseline, {
      ...defaultProfiles()[0],
      ramMiB: 0.001,
    });
    assert.equal(strict.passed, false);
    const badInput = await command(resolve(dir, "protected/calculator"), [], {
      input: "4096 1 0\n",
    });
    assert.equal(badInput.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("tool timeout and cancellation terminate execution instead of passing", async () => {
  const timeout = await command(
    process.execPath,
    ["-e", "setTimeout(()=>{},10000)"],
    { timeoutMs: 20 },
  );
  assert.equal(timeout.timedOut, true);
  assert.notEqual(timeout.code, 0);
  const controller = new AbortController();
  const task = command(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(task, /cancelled/);
});
