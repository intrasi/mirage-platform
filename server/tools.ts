import { randomUUID } from "node:crypto";
import { jsonHash } from "./config.js";
import type { Run } from "../shared/schema.js";
import type { Store } from "./store.js";

export const transformationContracts = [
  { name: "algebraic", effect: "May simplify under optimization." },
  { name: "encoded", effect: "Adds a volatile load and exclusive OR." },
  { name: "control-flow", effect: "Adds a volatile branch and arithmetic." },
].map((entry) => ({
  ...entry,
  language: "C11 fixed-width bounded integer calibration function",
  target: "Native hosted or trusted development adapter",
  obligations: [
    "Exact output equivalence",
    "Arithmetic safety",
    "Executable differential checks",
    "Absolute resource limits",
    "Retained compiled change",
  ],
}));

export async function recordedTool<T>(
  store: Store,
  run: Run,
  name: string,
  input: unknown,
  action: () => Promise<T>,
  save: () => void,
): Promise<T> {
  const id = randomUUID();
  const started = Date.now();
  const request = {
    id,
    name,
    projectId: run.projectId,
    runId: run.id,
    sourceHash: run.sourceHash,
    profileHash: run.profileHash,
    policyHash: run.policyHash,
    profileVersion: run.profile.version,
    inputHash: jsonHash(input),
    budget: {
      ...run.policy,
      deadlineAt: run.deadlineAt,
      used: { ...run.modelUsage },
    },
    startedAt: new Date(started).toISOString(),
  };
  store.put("tool", id, { request, state: "running" });
  store.event(run, "tool-started", `Running ${name}.`);
  store.audit("tool-started", id);
  try {
    const result = await action();
    const record = {
      request,
      state: "completed",
      outputHash: jsonHash(result),
      response:
        result && typeof result === "object" && "binary" in result
          ? { ...result, binary: undefined }
          : result,
      durationMs: Date.now() - started,
      failure: null,
    };
    const artifact = store.artifact(
      run.id,
      `${id}-tool.json`,
      JSON.stringify(record, null, 2),
      "application/json",
    );
    (run.toolRecords ||= []).push(artifact);
    store.put("tool", id, record);
    save();
    store.event(run, "tool-completed", `Completed ${name}.`, [artifact]);
    return result;
  } catch (error) {
    const record = {
      request,
      state: "failed",
      durationMs: Date.now() - started,
      failure: {
        classification: "tool-error-or-interruption",
        message: String(error),
      },
    };
    const artifact = store.artifact(
      run.id,
      `${id}-tool.json`,
      JSON.stringify(record, null, 2),
      "application/json",
    );
    (run.toolRecords ||= []).push(artifact);
    store.put("tool", id, record);
    save();
    store.event(run, "tool-failed", `${name} failed.`, [artifact]);
    throw error;
  }
}
