import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command } from "./process.js";
import { original, runner } from "./sample.js";
import { transformationContracts } from "./tools.js";
import { hash } from "./config.js";
import type { Run, Candidate } from "../shared/schema.js";
import type { Store } from "./store.js";
export async function packageRelease(
  store: Store,
  run: Run,
  candidate: Candidate | undefined,
  dir: string,
  signal?: AbortSignal,
) {
  const baselineReturn = !candidate;
  if (!candidate) {
    if (
      run.acceptedId ||
      !run.baseline?.proof ||
      run.baseline.proof.state !== "proved"
    )
      throw new Error("Baseline return requires a verified original build.");
    candidate = {
      id: "baseline",
      runId: run.id,
      index: -3,
      origin: "conventional",
      proposal: null,
      source: original,
      sourceHash: run.sourceHash,
      binaryHash: run.baseline.binaryHash,
      proof: run.baseline.proof,
      accepted: false,
      reason: "Unchanged baseline. No protection accepted.",
      artifacts: run.baseline.artifacts,
    };
  }
  const binary = store.artifactBytes(candidate.artifacts.binary);
  if (
    hash(binary) !== candidate.binaryHash ||
    hash(candidate.source) !== candidate.sourceHash ||
    candidate.proof?.sourceHash !== candidate.sourceHash ||
    (!candidate.accepted && !baselineReturn)
  )
    throw new Error("Release identity check failed.");
  const manifest = {
    version: 2,
    outcome: baselineReturn ? "unchanged-baseline" : "protected",
    changedFunctions: baselineReturn ? [] : run.policy.protectedFunctions,
    stopReason: run.stopReason,
    protectionBenefit: "not established",
    buildEnvironment: run.baseline?.environment || {
      target: run.baseline?.target,
      imageDigest: null,
    },
    runId: run.id,
    candidateId: candidate.id,
    sourceHash: candidate.sourceHash,
    baselineSourceHash: run.sourceHash,
    sourceSnapshot: store.get<any>("project", run.projectId)?.snapshot,
    dependencyInventory:
      store.get<any>("project", run.projectId)?.snapshot?.dependencies || [],
    runnerSourceHash: hash(runner),
    binaryHash: candidate.binaryHash,
    profileHash: run.profileHash,
    policyHash: run.policyHash,
    target: run.baseline?.target,
    compiler: run.baseline?.compiler,
    flags: run.baseline?.flags,
    proof: {
      state: candidate.proof!.state,
      tool: candidate.proof!.tool,
      version: candidate.proof!.version,
      harnessHash: candidate.proof!.harnessHash,
    },
    measurement: candidate.measurement,
    origin: baselineReturn ? "unchanged-original" : candidate.origin,
    gaps: run.gaps,
    modelUsage: run.modelUsage,
    signing: "unsigned demonstration",
    modelPlacement: run.placement,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  run.artifacts.manifest = store.artifact(
    run.id,
    "manifest.json",
    manifestText,
    "application/json",
  );
  for (const folder of ["source", "executable"]) {
    await mkdir(resolve(dir, folder), { recursive: true });
    await writeFile(resolve(dir, folder, "manifest.json"), manifestText);
  }
  await writeFile(resolve(dir, "source", "calibrate.c"), candidate.source);
  await writeFile(resolve(dir, "source", "runner.c"), runner);
  await writeFile(
    resolve(dir, "source", "Makefile"),
    "CC = clang\nCFLAGS = -std=c11 -O2 -fno-lto -Wall -Wextra -Werror\ncalculator: calibrate.c runner.c\n\t$(CC) $(CFLAGS) calibrate.c runner.c -o calculator\n",
  );
  await writeFile(
    resolve(dir, "source", "README.md"),
    "# Mirage protected sample\n\nRun `make` on the target shown in manifest.json.\nSend three integers per line to the calculator: raw, gain_q8, and offset.\n",
  );
  await writeFile(resolve(dir, "executable", "calculator"), binary, {
    mode: 0o755,
  });
  await writeFile(
    resolve(dir, "executable", "README.txt"),
    "Unsigned demonstration executable. Check manifest.json for the required operating system and processor.\n",
  );
  await writeFile(resolve(dir, "original.c"), original);
  await writeFile(resolve(dir, "protected.c"), candidate.source);
  const diff = await command(
    "diff",
    [
      "-u",
      "--label",
      "a/calibrate.c",
      "--label",
      "b/calibrate.c",
      "original.c",
      "protected.c",
    ],
    { cwd: dir, signal },
  );
  if (diff.code > 1) throw new Error("Source patch creation failed.");
  run.artifacts.patch = store.artifact(
    run.id,
    "protection.patch",
    diff.stdout,
    "text/x-diff",
  );
  for (const folder of ["source", "executable"]) {
    const archive = resolve(dir, `${folder}.tar.gz`);
    const r = await command(
      "tar",
      ["-czf", archive, "-C", resolve(dir, folder), "."],
      { signal },
    );
    if (r.code !== 0) throw new Error("Release archive creation failed.");
    run.artifacts[folder] = store.artifact(
      run.id,
      `mirage-${folder}.tar.gz`,
      await readFile(archive),
      "application/gzip",
    );
  }
  const report = [
    "# Mirage evidence report",
    "",
    baselineReturn
      ? "No transformation passed. This package contains the unchanged baseline."
      : "The selected candidate passed the declared correctness and resource checks.",
    "No protection benefit is established.",
    "",
    `Run: ${run.id}`,
    `Candidate: ${candidate.id}`,
    `Source SHA-256: ${candidate.sourceHash}`,
    `Binary SHA-256: ${candidate.binaryHash}`,
    `Target: ${run.baseline?.target}`,
    `Profile SHA-256: ${run.profileHash}`,
    `Policy SHA-256: ${run.policyHash}`,
    "",
    "## Checks",
    `- Source proof: ${candidate.proof!.state}.`,
    `- Baseline reproducibility: ${run.baseline?.reproducible ? "passed" : "not established"}.`,
    `- Candidate measurements: ${candidate.measurement?.passed ? "passed" : "not applicable to unchanged baseline"}.`,
    `- Changed functions: ${baselineReturn ? "none" : run.policy.protectedFunctions.join(", ")}.`,
    `- Stop reason: ${run.stopReason || "not recorded"}`,
    "",
    "Source proof covers the declared input domain and arithmetic checks.",
    "Compiler correctness, physical timing, and hardware behavior remain outside that proof.",
    "Resource tradeoffs do not measure resistance to reconstruction.",
    "",
    "## Measurements",
    `Executable size: ${candidate.measurement?.binaryBytes ?? binary.length} bytes.`,
    `Peak process memory: ${candidate.measurement?.rssBytes ?? run.baseline?.bench?.rssBytes} bytes.`,
    `Median calculation batch: ${candidate.measurement?.batchMs ?? run.baseline?.bench?.batchMs} milliseconds.`,
    `Relative slowdown: ${candidate.measurement?.slowdown ?? 1} times the matching baseline.`,
    `Executable comparisons: ${candidate.measurement?.differentialCases ?? "baseline only"}.`,
    `Model usage: ${run.modelUsage.tokens} tokens and ${run.modelUsage.costUsd} US dollars.`,
    "",
    "## Reconstruction",
    ...((run.reconstruction as any)?.analyses || []).map(
      (attempt: any) =>
        `${attempt.label}: ${attempt.state || (attempt.recovered ? "recovered" : "not recovered")}. ` +
        (attempt.heldout
          ? `${attempt.heldout.matched} of ${attempt.heldout.cases} held-out inputs matched. `
          : "") +
        (attempt.used
          ? `Analysis used ${attempt.used.seconds} seconds and ${attempt.used.tokens} tokens.`
          : String(attempt.error || "No completed evidence.")),
    ),
    "These attempts use a constrained arithmetic family. They do not establish general resistance.",
    "",
    "## Candidate decisions",
    ...run.candidates.map(
      (item) =>
        `- ${item.id}: ${item.origin}; ${item.accepted ? "accepted" : "not accepted"}. ${item.reason}`,
    ),
    "",
    "## Proof assumptions",
    "```json",
    JSON.stringify(candidate.proof!.assumptions, null, 2),
    "```",
    "",
    "## Unresolved checks",
    ...run.gaps.map((gap) => `- ${gap}`),
    "",
    "Private evidence contains source and proof inputs. Distribute the executable archive separately.",
  ].join("\n");
  run.artifacts.report = store.artifact(
    run.id,
    "evidence-report.md",
    report,
    "text/markdown",
  );
  run.artifacts.evidence = store.artifact(
    run.id,
    "evidence.json",
    JSON.stringify(
      {
        manifest,
        run,
        project: store.get("project", run.projectId),
        attachments: (store.get<string[]>("run-attachments", run.id) || []).map(
          (id) => store.get("attachment", id),
        ),
        transformationContracts,
        events: store.events(run.id),
        warning:
          "Private developer evidence contains source code. Distribute the executable package separately.",
      },
      null,
      2,
    ),
    "application/json",
  );
  const developer = resolve(dir, "developer");
  await mkdir(developer, { recursive: true });
  await writeFile(resolve(developer, "report.md"), report);
  await writeFile(
    resolve(developer, "evidence.json"),
    store.artifactBytes(run.artifacts.evidence),
  );
  const references = new Set([
    ...Object.values(run.artifacts),
    ...(Object.values(run.baseline?.artifacts || {}) as string[]),
    ...run.candidates.flatMap((item) => Object.values(item.artifacts)),
    ...(run.toolRecords || []),
    ...store.events(run.id).flatMap((event) => event.evidence),
    ...(store.get<string[]>("run-attachments", run.id) || []),
    ...[store.get<any>("project", run.projectId)?.snapshot?.artifactId].filter(
      (id): id is string => typeof id === "string",
    ),
  ]);
  const index = [];
  for (const id of references) {
    const info = store.artifactInfo(id);
    if (!info) throw new Error("Developer evidence reference is missing.");
    await writeFile(resolve(developer, id), store.artifactBytes(id));
    index.push(info);
  }
  await writeFile(
    resolve(developer, "artifact-index.json"),
    JSON.stringify(index, null, 2),
  );
  const archive = resolve(dir, "developer.tar.gz");
  const result = await command("tar", ["-czf", archive, "-C", developer, "."], {
    signal,
  });
  if (result.code !== 0) throw new Error("Developer bundle creation failed.");
  run.artifacts.developer = store.artifact(
    run.id,
    "mirage-developer-evidence.tar.gz",
    await readFile(archive),
    "application/gzip",
  );
  store.audit("release-package", run.id);
  store.saveRun(run);
}
