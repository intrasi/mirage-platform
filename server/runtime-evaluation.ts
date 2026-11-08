import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { platform } from "node:os";
import { hash, root } from "./config.js";
import { command } from "./process.js";
import type { Policy } from "../shared/schema.js";
import { reconstruct, reconstructWithModel } from "./reconstruction.js";
import {
  runtimeSymbolsSchema,
  type RuntimeSymbols,
} from "./runtime-symbols.js";

// Evaluate the existing trusted runtime package through the same public oracle contract.
// The analyst never receives weights, private source, or reference answers.
export async function evaluateRuntime(
  signal?: AbortSignal,
  model?: {
    policy: Policy;
    usage: { tokens: number; costUsd: number };
    save: () => void;
  },
) {
  const directory = resolve(root, "neural-runtime");
  const target = resolve(directory, "artifacts/target");
  let report: any, manifest: any;
  try {
    report = JSON.parse(
      await readFile(
        resolve(directory, "artifacts/package-report.json"),
        "utf8",
      ),
    );
    manifest = JSON.parse(
      await readFile(resolve(target, "manifest.json"), "utf8"),
    );
  } catch {
    return {
      state: "unavailable",
      reason: "Build the trusted runtime package before comparison.",
    };
  }
  if (
    !String(manifest.target)
      .toLowerCase()
      .startsWith(platform() === "darwin" ? "macos" : platform())
  )
    return {
      state: "unavailable",
      reason: "The runtime package targets a different operating system.",
    };
  const archive = await readFile(
    resolve(directory, "artifacts/mirage-neural-runtime.tar.gz"),
  );
  if (hash(archive) !== report.sha256)
    throw new Error("Runtime package identity mismatch.");
  for (const [name, digest] of Object.entries(manifest.files)) {
    const file = resolve(target, name);
    if (!file.startsWith(target + sep) || hash(await readFile(file)) !== digest)
      throw new Error("Runtime package file identity mismatch.");
  }
  const oracle = async (inputs: number[][]) => {
    const execution = await command(
      resolve(directory, ".venv/bin/python"),
      ["run.py"],
      {
        cwd: target,
        signal,
        timeoutMs: 30000,
        input: inputs.map((row) => row.join(" ")).join("\n") + "\n",
      },
    );
    if (execution.code !== 0)
      throw new Error("Runtime comparison execution failed.");
    const values = execution.stdout.trim().split("\n").map(Number);
    if (
      values.length !== inputs.length ||
      values.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 4095,
      )
    )
      throw new Error("Runtime comparison returned invalid results.");
    return values;
  };
  let disassembly = "";
  let publicSymbols: RuntimeSymbols | undefined;
  if (model) {
    if (manifest.inspection) {
      if (
        manifest.inspection !== "inspection.json" ||
        !manifest.files["inspection.json"]
      )
        throw new Error(
          "Runtime inspection metadata is not in the verified manifest.",
        );
      publicSymbols = runtimeSymbolsSchema.parse(
        JSON.parse(await readFile(resolve(target, "inspection.json"), "utf8")),
      );
    }
    const extension = Object.keys(manifest.files).find((name) =>
      /^_mirage_native[^/]*\.(so|dylib)$/.test(name),
    );
    if (!extension)
      throw new Error(
        "The runtime package has no native interpreter artifact.",
      );
    const result = await command(
      "objdump",
      ["-d", resolve(target, extension)],
      { signal, maxBytes: 16 * 1024 * 1024 },
    );
    if (result.code !== 0) throw new Error("Runtime disassembly failed.");
    disassembly = result.stdout;
  }
  const result = model
    ? await reconstructWithModel(
        report.sha256,
        disassembly,
        oracle,
        model.policy,
        model.usage,
        model.save,
        signal,
        undefined,
        publicSymbols,
      )
    : await reconstruct(report.sha256, oracle);
  return {
    ...result,
    artifactType: "neural runtime package",
    manifestHash: hash(JSON.stringify(manifest)),
    execution: "real local packaged runtime",
    inspectionSurface: publicSymbols
      ? "native disassembly and public multilingual names"
      : "native disassembly",
    claim: "This comparison does not establish a protection benefit.",
  };
}
