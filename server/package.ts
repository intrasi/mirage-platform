import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command } from "./process.js";
import { original, runner } from "./sample.js";
import { hash } from "./config.js";
import type { Run, Candidate } from "../shared/schema.js";
import type { Store } from "./store.js";
export async function packageRelease(
  store: Store,
  run: Run,
  candidate: Candidate,
  dir: string,
  signal?: AbortSignal,
) {
  const binary = store.artifactBytes(candidate.artifacts.binary);
  if (
    hash(binary) !== candidate.binaryHash ||
    hash(candidate.source) !== candidate.sourceHash ||
    candidate.proof?.sourceHash !== candidate.sourceHash ||
    !candidate.accepted
  )
    throw new Error("Release identity check failed.");
  const manifest = {
    version: 1,
    runId: run.id,
    candidateId: candidate.id,
    sourceHash: candidate.sourceHash,
    baselineSourceHash: run.sourceHash,
    runnerSourceHash: hash(runner),
    binaryHash: candidate.binaryHash,
    profileHash: run.profileHash,
    policyHash: run.policyHash,
    target: run.baseline?.target,
    compiler: run.baseline?.compiler,
    flags: run.baseline?.flags,
    proof: {
      state: candidate.proof.state,
      tool: candidate.proof.tool,
      version: candidate.proof.version,
      harnessHash: candidate.proof.harnessHash,
    },
    measurement: candidate.measurement,
    origin: candidate.origin,
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
  run.artifacts.evidence = store.artifact(
    run.id,
    "evidence.json",
    JSON.stringify(
      {
        manifest,
        run,
        events: store.events(run.id),
        warning:
          "Private developer evidence contains source code. Distribute the executable package separately.",
      },
      null,
      2,
    ),
    "application/json",
  );
  store.audit("release-package", run.id);
  store.saveRun(run);
}
