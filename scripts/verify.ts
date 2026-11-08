import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Store } from "../server/store.js";
import { Worker } from "../server/worker.js";
import { defaultProfiles } from "../server/profiles.js";
import { policySchema, type Run } from "../shared/schema.js";
import { original, runner } from "../server/sample.js";
import { hash, jsonHash, root } from "../server/config.js";
const sample = resolve(root, "sample");
await mkdir(sample, { recursive: true });
await writeFile(resolve(sample, "calibrate.c"), original);
await writeFile(resolve(sample, "runner.c"), runner);
const store = new Store();
const profile = defaultProfiles()[0],
  policy = policySchema.parse({ maxAttempts: 3 });
const run: Run = {
  id: randomUUID(),
  projectId: randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: "queued",
  profile,
  policy,
  sourceHash: hash(original),
  profileHash: jsonHash(profile),
  policyHash: jsonHash(policy),
  candidates: [],
  artifacts: {},
  cancelRequested: false,
  modelUsage: { tokens: 0, costUsd: 0 },
  gaps: [],
};
store.put("project", run.projectId, {
  id: run.projectId,
  name: "Sample verification",
  source: "sample",
  snapshot: { sourceHash: run.sourceHash },
});
store.saveRun(run);
const worker = new Worker(store);
try {
  await worker.process(run);
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        state: run.state,
        target: run.baseline?.target,
        candidates: run.candidates.map((c) => ({
          origin: c.origin,
          transform: c.proposal?.transform,
          proof: c.proof?.state,
          accepted: c.accepted,
          reason: c.reason,
          measurement: c.measurement,
        })),
        reconstruction: run.reconstruction,
        artifacts: run.artifacts,
        gaps: run.gaps,
      },
      null,
      2,
    ),
  );
  if (run.state !== "succeeded") process.exitCode = 1;
} catch (e) {
  run.state = "failed";
  run.error = String(e);
  store.saveRun(run);
  console.error(e);
  process.exitCode = 1;
} finally {
  store.close();
}
