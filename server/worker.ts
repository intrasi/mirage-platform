import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { Store } from "./store.js";
import { hash, jsonHash, dataDir } from "./config.js";
import { original, incorrect, transform, relationalHarness } from "./sample.js";
import {
  executor,
  measure,
  type Build,
  type Executor,
  targetMatches,
} from "./executor.js";
import { catalog, propose, modelConfiguration } from "./model.js";
import { packageRelease } from "./package.js";
import { evaluateRuntime } from "./runtime-evaluation.js";
import { recordedTool } from "./tools.js";
import { placement, profileCapabilities } from "./profiles.js";
import { reconstruct, reconstructWithModel } from "./reconstruction.js";
import {
  terminal,
  type Run,
  type Candidate,
  type State,
  type Proposal,
} from "../shared/schema.js";
export class Worker {
  owner = randomUUID();
  active?: { id: string; controller: AbortController };
  timer?: ReturnType<typeof setInterval>;
  heartbeat?: ReturnType<typeof setInterval>;
  closed = false;
  externalBusy = false;
  constructor(
    public store: Store,
    public engine: Executor = executor(),
  ) {}
  start() {
    this.timer = setInterval(() => void this.tick(), 400);
    this.heartbeat = setInterval(() => {
      if (this.active && !this.store.acquire(this.owner))
        this.active.controller.abort();
    }, 2000);
    void this.tick();
  }
  async stop() {
    if (this.closed && !this.active) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.active?.controller.abort();
    while (this.active) await new Promise((r) => setTimeout(r, 20));
    this.store.release(this.owner);
  }
  cancel(id: string) {
    const r = this.store.get<Run>("run", id);
    if (!r) throw new Error("Run does not exist.");
    if (!terminal.has(r.state)) {
      r.cancelRequested = true;
      if (r.state === "queued") r.state = "cancelled";
      this.store.saveRun(r);
      this.store.event(r, "cancellation", "Cancellation requested.");
      if (this.active?.id === id) this.active.controller.abort();
    }
    return r;
  }
  async tick() {
    if (
      this.closed ||
      this.active ||
      this.externalBusy ||
      !this.store.acquire(this.owner)
    )
      return;
    const runs = this.store
      .list<Run>("run")
      .filter((r) => !terminal.has(r.state))
      .reverse();
    const r = runs[0];
    if (!r) return;
    const controller = new AbortController();
    this.active = { id: r.id, controller };
    if (r.state !== "queued")
      this.store.event(
        r,
        "recovery",
        "Recovered an interrupted run. Existing evidence is retained.",
      );
    try {
      await this.process(r, controller);
    } catch (e) {
      const current = this.store.get<Run>("run", r.id);
      if (this.closed) {
        this.store.event(
          r,
          "recovery",
          "Worker stopped. This run can resume on restart.",
        );
      } else {
        r.state = current?.cancelRequested ? "cancelled" : "failed";
        r.error = String((e as Error).message || e);
        this.store.saveRun(r);
        this.store.event(r, r.state, r.error);
      }
    } finally {
      this.active = undefined;
    }
  }
  async process(r: Run, controller = new AbortController()) {
    const budgetController = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      budgetController.signal,
    ]);
    const dir = resolve(this.store.directory, "work", r.id);
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    const priorElapsed = r.elapsedMs || 0;
    r.startedAt ||= new Date(started - priorElapsed).toISOString();
    r.deadlineAt ||= new Date(
      Date.parse(r.startedAt) + r.policy.maxSeconds * 1000,
    ).toISOString();
    const remaining = Date.parse(r.deadlineAt) - started;
    const timer = setTimeout(
      () => budgetController.abort(new Error("Search duration limit reached.")),
      Math.max(1, remaining - Math.min(15000, remaining * 0.2)),
    );
    const save = () => {
      r.elapsedMs = priorElapsed + Date.now() - started;
      r.cancelRequested =
        this.store.get<Run>("run", r.id)?.cancelRequested || r.cancelRequested;
      this.store.saveRun(r);
    };
    const stage = (state: State, message: string) => {
      if (signal.aborted)
        throw signal.reason || new Error("Operation cancelled.");
      if (this.store.get<Run>("run", r.id)?.cancelRequested)
        throw new Error("Operation cancelled.");
      r.state = state;
      save();
      this.store.event(r, state, message);
    };
    const tool = <T>(name: string, input: unknown, action: () => Promise<T>) =>
      recordedTool(this.store, r, name, input, action, save);
    const keepBuild = (build: Build, prefix: string) => ({
      binary: this.store.artifact(r.id, `${prefix}-calculator`, build.binary),
      assembly: this.store.artifact(
        r.id,
        `${prefix}-disassembly.txt`,
        build.assembly,
        "text/plain",
      ),
    });
    try {
      stage("preparing", "Checking the frozen source, target, and policy.");
      if (
        hash(original) !== r.sourceHash ||
        jsonHash(r.profile) !== r.profileHash ||
        jsonHash(r.policy) !== r.policyHash
      )
        throw new Error("Frozen run identity changed.");
      if (remaining <= 0)
        throw new Error(
          "The run deadline expired. Completed evidence remains available.",
        );
      const capabilities = await tool("capabilities", {}, () =>
        this.engine.capabilities(),
      );
      const support = profileCapabilities(
        r.profile,
        this.engine.kind,
        capabilities.target,
      );
      if (support.gaps.length) throw new Error(support.gaps.join(" "));
      if (
        (r.policy.mode === "model" || r.policy.analyst === "model") &&
        !r.policy.allowSourceDisclosure
      )
        throw new Error("Source disclosure is not permitted by this policy.");
      if (this.engine.kind === "trusted-local" && !targetMatches(r.profile))
        throw new Error(
          "This target requires a configured worker for its operating system and processor.",
        );
      if (
        this.engine.kind === "hosted" &&
        (r.profile.operatingSystem !== "linux" ||
          r.profile.architecture !== "x86_64" ||
          capabilities.target !== "linux-x64")
      )
        throw new Error("The hosted worker must report Linux x86-64.");
      if (
        this.engine.kind === "hosted" &&
        !/^sha256:[a-f0-9]{64}$/.test(capabilities.imageDigest || "")
      )
        throw new Error(
          "The hosted worker must report its exact image digest.",
        );
      r.placement = placement(r.profile);
      r.gaps = [
        ...(this.engine.kind === "trusted-local"
          ? ["Hosted Linux x86-64 execution has not run."]
          : []),
        ...(r.policy.mode === "catalog"
          ? ["Deterministic catalog proposals are not live agent output."]
          : []),
        "Physical device validation has not run. This native package does not include the separate runtime model.",
        ...(r.policy.analyst === "model"
          ? []
          : ["Model-based reconstruction analysis has not run."]),
      ];
      let baseline: Build;
      if (r.baseline) {
        baseline = {
          ...r.baseline,
          binary: this.store.artifactBytes(r.baseline.artifacts.binary),
        } as Build;
        this.store.event(
          r,
          "baseline",
          "Reused the recorded baseline with its original hashes.",
        );
      } else {
        stage(
          "baseline",
          "Compiling the original calculator twice and measuring its executable.",
        );
        baseline = await tool(
          "baseline-build",
          { sourceHash: hash(original), reproduce: true },
          () =>
            this.engine.build(original, resolve(dir, "baseline"), signal, true),
        );
        if (
          this.engine.kind === "hosted" &&
          baseline.environment?.imageDigest !== capabilities.imageDigest
        )
          throw new Error(
            "Hosted image identity changed before the baseline build.",
          );
        const artifacts = keepBuild(baseline, "baseline");
        const { binary, ...metadata } = baseline;
        r.baseline = { ...metadata, originalSource: original, artifacts };
        save();
      }
      if (!r.baseline!.proof) {
        const proof = await tool(
          "baseline-proof",
          { sourceHash: hash(original) },
          () =>
            this.engine.prove(original, resolve(dir, "baseline-proof"), signal),
        );
        r.baseline!.proof = proof;
        r.baseline!.artifacts.harness = this.store.artifact(
          r.id,
          "baseline-proof-input.c",
          relationalHarness(original),
          "text/plain",
        );
        r.baseline!.artifacts.proof = this.store.artifact(
          r.id,
          "baseline-proof.txt",
          proof.log,
          "text/plain",
        );
        save();
        if (proof.state !== "proved")
          throw new Error(
            "Baseline safety and equivalence proof did not pass.",
          );
      } else if (r.baseline!.proof.state !== "proved") {
        throw new Error("Recorded baseline proof did not pass.");
      }
      const assess = async (
        source: string,
        origin: Candidate["origin"],
        proposal: Proposal | null,
        index: number,
      ): Promise<Candidate> => {
        const candidate: Candidate = {
          id: randomUUID(),
          runId: r.id,
          index,
          origin,
          proposal,
          source,
          sourceHash: hash(source),
          accepted: false,
          reason: "Verification is pending.",
          artifacts: {},
        };
        r.candidates.push(candidate);
        save();
        stage(
          "verifying",
          `${origin === "injected-control" ? "Injected incorrect control" : proposal?.transform || origin}: checking exact output equivalence.`,
        );
        const cdir = resolve(dir, candidate.id);
        candidate.proof = await tool(
          "candidate-proof",
          { candidateId: candidate.id, sourceHash: candidate.sourceHash },
          () => this.engine.prove(source, cdir, signal),
        );
        candidate.artifacts.harness = this.store.artifact(
          r.id,
          `${candidate.id}-proof-input.c`,
          relationalHarness(source),
          "text/plain",
        );
        candidate.artifacts.proof = this.store.artifact(
          r.id,
          `${candidate.id}-proof.txt`,
          candidate.proof.log,
          "text/plain",
        );
        candidate.artifacts.source = this.store.artifact(
          r.id,
          `${candidate.id}.c`,
          source,
          "text/plain",
        );
        this.store.event(
          r,
          "proof",
          `Formal result: ${candidate.proof.state}.`,
          [candidate.artifacts.proof],
        );
        save();
        if (candidate.proof.state !== "proved") {
          candidate.reason = `Formal verification returned ${candidate.proof.state}.`;
          save();
          return candidate;
        }
        if (origin === "injected-control")
          throw new Error(
            "The invalid control passed proof. The acceptance gate is not valid.",
          );
        const b = await tool(
          "candidate-build",
          { candidateId: candidate.id, sourceHash: candidate.sourceHash },
          () => this.engine.build(source, cdir, signal, true),
        );
        if (
          b.compiler !== baseline.compiler ||
          b.target !== baseline.target ||
          jsonHash(b.flags) !== jsonHash(baseline.flags) ||
          b.environment?.imageDigest !== baseline.environment?.imageDigest
        )
          throw new Error("Build environment identity changed during the run.");
        candidate.binaryHash = b.binaryHash;
        candidate.artifacts = {
          ...candidate.artifacts,
          ...keepBuild(b, candidate.id),
        };
        candidate.measurement = measure(b, baseline, r.profile);
        candidate.accepted =
          origin !== "conventional" &&
          candidate.measurement.passed &&
          candidate.measurement.assemblyChanged;
        candidate.reason = candidate.accepted
          ? "Exact source proof, executable comparisons, and resource checks passed."
          : !candidate.measurement.passed
            ? "Executable comparison or resource limit failed."
            : !candidate.measurement.assemblyChanged
              ? "The compiler removed the transformation from the protected function."
              : "Conventional comparison build.";
        if (candidate.accepted) {
          const best = r.candidates.find((x) => x.id === r.acceptedId);
          if (
            !best ||
            candidate.measurement.batchMs <
              (best.measurement?.batchMs ?? Infinity)
          )
            r.acceptedId = candidate.id;
        }
        save();
        this.store.event(r, "candidate", candidate.reason, [
          candidate.artifacts.binary,
        ]);
        return candidate;
      };
      // An interrupted candidate remains visible. It cannot become accepted without all checks.
      for (const c of r.candidates)
        if (c.reason === "Verification is pending.")
          c.reason =
            "Interrupted before all checks completed. Excluded from acceptance.";
      if (
        !r.candidates.some(
          (c) =>
            c.origin === "injected-control" &&
            c.proof?.state === "counterexample",
        )
      ) {
        const invalid = await assess(incorrect, "injected-control", null, -2);
        if (invalid.proof?.state !== "counterexample")
          throw new Error(
            "The invalid control needs a real counterexample before search can begin.",
          );
      }
      if (
        !r.candidates.some((c) => c.origin === "conventional" && c.binaryHash)
      )
        await assess(transform(catalog[2]), "conventional", catalog[2], -1);
      try {
        let failures = 0;
        for (const prior of [...r.candidates]
          .reverse()
          .filter((c) => c.origin === "catalog" || c.origin === "model")) {
          if (prior.accepted) break;
          failures++;
        }
        for (
          let i = r.candidates.filter(
            (c) => c.origin === "catalog" || c.origin === "model",
          ).length;
          i < r.policy.maxAttempts;
          i++
        ) {
          if (failures >= r.policy.maxRepeatedFailures) {
            r.stopReason = "Repeated candidate failure limit reached.";
            break;
          }
          stage(
            "searching",
            r.policy.mode === "model"
              ? "Requesting a bounded model proposal."
              : "Selecting a deterministic catalog proposal.",
          );
          let p: Proposal;
          if (r.policy.mode === "model") {
            const feedback = r.candidates.map((c) => ({
              proposal: c.proposal,
              proof: c.proof?.state,
              reason: c.reason,
              measurement: c.measurement,
            }));
            const result = await tool("model-proposal", { feedback }, () =>
              propose(feedback, r.policy, r.modelUsage, signal, fetch, save),
            );
            p = result.proposal;
            const transcript = this.store.artifact(
              r.id,
              `model-${i}.json`,
              JSON.stringify(result.transcript, null, 2),
              "application/json",
            );
            this.store.event(
              r,
              "model",
              `Received proposal from ${result.model}.`,
              [transcript],
            );
            save();
          } else {
            p = {
              ...catalog[i % catalog.length],
              key:
                catalog[i % catalog.length].key +
                (Math.floor(i / catalog.length) % 10),
            };
          }
          const assessed = await assess(
            transform(p),
            r.policy.mode === "model" ? "model" : "catalog",
            p,
            i,
          );
          failures = assessed.accepted ? 0 : failures + 1;
          if (failures >= r.policy.maxRepeatedFailures) {
            r.stopReason = "Repeated candidate failure limit reached.";
            break;
          }
        }
        r.stopReason ||= "Candidate attempt limit reached.";
      } catch (e) {
        r.stopReason = String((e as Error).message || e);
        this.store.event(
          r,
          "search-stopped",
          String((e as Error).message || e),
        );
        if (
          (!r.acceptedId &&
            !budgetController.signal.aborted &&
            !/remaining budget/.test(r.stopReason)) ||
          this.store.get<Run>("run", r.id)?.cancelRequested ||
          this.closed
        )
          throw e;
      }
      r.outcome = r.acceptedId ? "protected" : "unchanged-baseline";
      if (!r.acceptedId)
        this.store.event(
          r,
          "baseline-return",
          "No candidate passed. Returning the unchanged baseline without a protection claim.",
        );
      const accepted = r.candidates.filter((c) => c.accepted && c.measurement);
      r.paretoCandidateIds = accepted
        .filter(
          (a) =>
            !accepted.some((b) => {
              const x = a.measurement!,
                y = b.measurement!;
              return (
                b.id !== a.id &&
                y.batchMs <= x.batchMs &&
                y.rssBytes <= x.rssBytes &&
                y.binaryBytes <= x.binaryBytes &&
                (y.batchMs < x.batchMs ||
                  y.rssBytes < x.rssBytes ||
                  y.binaryBytes < x.binaryBytes)
              );
            }),
        )
        .map((c) => c.id);
      // Stop accepting proposals at the deadline. Preserve the best result and finish a bounded export.
      clearTimeout(timer);
      const finishSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, remaining - (Date.now() - started))),
      ]);
      r.state = "evaluating";
      save();
      this.store.event(
        r,
        "evaluating",
        "Running the same black-box reconstruction analyst against all three builds.",
      );
      const best = r.candidates.find((c) => c.id === r.acceptedId);
      const conventional = r.candidates.find(
        (c) => c.origin === "conventional" && c.binaryHash,
      );
      const comparisons = [
        {
          label: "original",
          hash: baseline.binaryHash,
          id: r.baseline!.artifacts.binary,
        },
        {
          label: "conventional",
          hash: conventional?.binaryHash,
          id: conventional?.artifacts.binary,
        },
        {
          label: "selected",
          hash: best?.binaryHash || baseline.binaryHash,
          id: best?.artifacts.binary || r.baseline!.artifacts.binary,
        },
      ];
      const analyses = [];
      for (const b of comparisons) {
        if (!b.id || !b.hash) {
          analyses.push({ label: b.label, state: "unavailable" });
          continue;
        }
        const bytes = this.store.artifactBytes(b.id);
        const oracle = (x: number[][]) =>
          this.engine.execute(
            bytes,
            resolve(dir, `analysis-${b.label}`),
            x,
            finishSignal,
          );
        try {
          const assemblyId =
            b.label === "original" || (!best && b.label === "selected")
              ? r.baseline!.artifacts.assembly
              : b.label === "conventional"
                ? conventional?.artifacts.assembly
                : best?.artifacts.assembly;
          const result = await tool(
            "reconstruction",
            { binaryHash: b.hash, analyst: r.policy.analyst },
            () =>
              r.policy.analyst === "model"
                ? reconstructWithModel(
                    b.hash!,
                    assemblyId
                      ? this.store.artifactBytes(assemblyId).toString()
                      : "",
                    oracle,
                    r.policy,
                    r.modelUsage,
                    save,
                    finishSignal,
                  )
                : reconstruct(b.hash!, oracle),
          );
          analyses.push({ label: b.label, ...result });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          analyses.push({
            label: b.label,
            binaryHash: b.hash,
            state: finishSignal.aborted ? "timeout" : "tool-error",
            error: String(error),
            censored: finishSignal.aborted,
          });
          r.gaps.push(`Reconstruction for ${b.label} did not complete.`);
        }
      }
      if (this.engine.kind === "trusted-local") {
        try {
          const runtime = await tool(
            "runtime-reconstruction",
            { analyst: r.policy.analyst },
            () =>
              evaluateRuntime(
                finishSignal,
                r.policy.analyst === "model"
                  ? { policy: r.policy, usage: r.modelUsage, save }
                  : undefined,
              ),
          );
          analyses.push({ label: "runtime-model", ...runtime });
          if ("state" in runtime)
            r.gaps.push("The neural runtime comparison is unavailable.");
        } catch (error) {
          if (controller.signal.aborted) throw error;
          analyses.push({
            label: "runtime-model",
            state: "tool-error",
            error: String(error),
          });
          r.gaps.push("The neural runtime comparison did not complete.");
        }
      } else {
        r.gaps.push(
          "The neural runtime comparison requires a trusted local runtime package for the same target.",
        );
      }
      r.reconstruction = {
        analyses,
        claim:
          "No general protection benefit is established. Review each measured reconstruction outcome.",
      };
      save();
      r.state = "packaging";
      save();
      this.store.event(
        r,
        "packaging",
        "Creating separate source and executable packages with matching manifests.",
      );
      await packageRelease(
        this.store,
        r,
        best,
        resolve(dir, "release"),
        finishSignal,
      );
      if (
        controller.signal.aborted ||
        this.store.get<Run>("run", r.id)?.cancelRequested
      )
        throw new Error("Operation cancelled.");
      r.state = "succeeded";
      r.elapsedMs = priorElapsed + Date.now() - started;
      save();
      this.store.event(
        r,
        "succeeded",
        r.outcome === "protected"
          ? "The verified sample package is ready. External acceptance gaps remain visible."
          : "The unchanged baseline package is ready. No protection was accepted.",
        Object.values(r.artifacts),
      );
    } finally {
      clearTimeout(timer);
      if (r.state !== "succeeded") {
        r.elapsedMs = priorElapsed + Date.now() - started;
        save();
      }
    }
  }
}
