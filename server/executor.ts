import { mkdir, writeFile, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { platform, arch, release } from "node:os";
import { command } from "./process.js";
import { cbmcPath, clangPath, hash } from "./config.js";
import { original, runner, relationalHarness, cases } from "./sample.js";
import {
  domain,
  limits,
  type DeviceProfile,
  type Proof,
  type Measurement,
} from "../shared/schema.js";
export type Build = {
  binary: Buffer;
  assembly: string;
  compiler: string;
  flags: string[];
  target: string;
  sourceHash: string;
  binaryHash: string;
  bench: { rssBytes: number; samplesMs: number[]; batchMs: number };
  output: string;
  reproducible: boolean;
  environment?: {
    target: string;
    imageDigest: string | null;
    compiler: string;
    flags: string[];
    operatingSystemRelease?: string;
    runtimeDependencies?: string;
  };
};
export const compileFlags = [
  "-std=c11",
  "-O2",
  "-fno-lto",
  "-Wall",
  "-Wextra",
  "-Werror",
];
export function nativeTarget() {
  return `${platform()}-${arch()}`;
}
export function targetMatches(p: DeviceProfile) {
  return (
    p.operatingSystem === platform() &&
    p.architecture === (arch() === "arm64" ? "aarch64" : "x86_64")
  );
}
export function median(x: number[]) {
  return [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
}
export class LocalExecutor {
  kind = "trusted-local";
  async capabilities() {
    const [compiler, proof, solver] = await Promise.all([
      command(clangPath, ["--version"]).catch(() => null),
      command(cbmcPath, ["--version"]).catch(() => null),
      command("z3", ["--version"]).catch(() => null),
    ]);
    return {
      kind: this.kind,
      target: nativeTarget(),
      compiler: compiler?.stdout.trim() || null,
      proof:
        proof?.code === 0 && solver?.code === 0 ? proof.stdout.trim() : null,
      solver: solver?.stdout.trim() || null,
      hosted: false,
    };
  }
  async prove(
    source: string,
    dir: string,
    signal?: AbortSignal,
  ): Promise<Proof> {
    await mkdir(dir, { recursive: true });
    const harness = relationalHarness(source);
    await writeFile(resolve(dir, "proof.c"), harness);
    const args = [
      "proof.c",
      "--function",
      "main",
      "--bounds-check",
      "--pointer-check",
      "--div-by-zero-check",
      "--signed-overflow-check",
      "--unsigned-overflow-check",
      "--unwinding-assertions",
      "--unwind",
      "1",
      "--trace",
      "--z3",
    ];
    let version = "unavailable";
    try {
      version =
        (await command(cbmcPath, ["--version"], { signal })).stdout.trim() +
        " / " +
        (await command("z3", ["--version"], { signal })).stdout.trim();
      const r = await command(cbmcPath, args, {
        cwd: dir,
        timeoutMs: limits.proofSeconds * 1000,
        signal,
      });
      return {
        state: r.timedOut
          ? "timeout"
          : r.code === 0 && r.stdout.includes("VERIFICATION SUCCESSFUL")
            ? "proved"
            : r.code === 10
              ? "counterexample"
              : "tool-error",
        tool: "CBMC",
        version,
        assumptions: {
          domain,
          pureFunction: true,
          integerWidths: "uint16_t, int16_t, uint32_t, int32_t",
          loops:
            "No loops in protected function. Unwinding assertions enabled.",
          compilerBackend:
            "Not included. Binary differential checks are separate.",
        },
        log: r.stdout + r.stderr,
        durationMs: r.durationMs,
        sourceHash: hash(source),
        harnessHash: hash(harness),
        command: ["cbmc", ...args],
      };
    } catch (e) {
      if (signal?.aborted) throw e;
      return {
        state: "unsupported",
        tool: "CBMC",
        version,
        assumptions: { domain },
        log: String(e),
        durationMs: 0,
        sourceHash: hash(source),
        harnessHash: hash(harness),
        command: ["cbmc", ...args],
      };
    }
  }
  async build(
    source: string,
    dir: string,
    signal?: AbortSignal,
    reproduce = false,
  ): Promise<Build> {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "calibrate.c"), source);
    await writeFile(resolve(dir, "runner.c"), runner);
    const args = [
      ...compileFlags,
      "calibrate.c",
      "runner.c",
      "-o",
      "calculator",
    ];
    const r = await command(clangPath, args, { cwd: dir, signal });
    if (r.code !== 0) throw new Error(`Compilation failed: ${r.stderr}`);
    const binary = await readFile(resolve(dir, "calculator"));
    let reproducible = false;
    if (reproduce) {
      const clean = resolve(dir, "reproduction-" + randomUUID());
      await mkdir(clean, { recursive: true });
      await writeFile(resolve(clean, "calibrate.c"), source);
      await writeFile(resolve(clean, "runner.c"), runner);
      const again = await command(clangPath, args, { cwd: clean, signal });
      reproducible =
        again.code === 0 &&
        hash(binary) === hash(await readFile(resolve(clean, "calculator")));
      if (!reproducible)
        throw new Error("Baseline build was not reproducible.");
    }
    const dis = await command("objdump", ["-d", resolve(dir, "calculator")], {
      signal,
    });
    if (dis.code !== 0) throw new Error("Release binary disassembly failed.");
    const bench = await command(resolve(dir, "calculator"), ["--bench"], {
      signal,
    });
    if (bench.code !== 0) throw new Error("Executable benchmark failed.");
    const parsed = JSON.parse(bench.stdout);
    if (
      !Array.isArray(parsed.samplesMs) ||
      parsed.samplesMs.length !== 9 ||
      !parsed.samplesMs.every(
        (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0,
      ) ||
      !Number.isFinite(parsed.rssBytes) ||
      parsed.rssBytes <= 0
    )
      throw new Error("Invalid benchmark evidence.");
    const input =
      cases()
        .map((x) => x.join(" "))
        .join("\n") + "\n";
    const output = await command(resolve(dir, "calculator"), [], {
      input,
      signal,
    });
    if (output.code !== 0)
      throw new Error("Executable differential check failed.");
    const compiler = (
      await command(clangPath, ["--version"], { signal })
    ).stdout.trim();
    const dependencies = await command(
      platform() === "darwin" ? "otool" : "readelf",
      [platform() === "darwin" ? "-L" : "-d", resolve(dir, "calculator")],
      { signal },
    );
    if (dependencies.code !== 0)
      throw new Error("Runtime dependency inspection failed.");
    return {
      environment: {
        target: nativeTarget(),
        imageDigest: process.env.MIRAGE_WORKER_IMAGE_DIGEST || null,
        compiler,
        flags: compileFlags,
        operatingSystemRelease: release(),
        runtimeDependencies: dependencies.stdout,
      },
      binary,
      assembly: dis.stdout,
      compiler: (
        await command(clangPath, ["--version"], { signal })
      ).stdout.trim(),
      flags: compileFlags,
      target: nativeTarget(),
      sourceHash: hash(source),
      binaryHash: hash(binary),
      bench: { ...parsed, batchMs: median(parsed.samplesMs) },
      output: output.stdout,
      reproducible,
    };
  }
  async execute(
    binary: Buffer,
    dir: string,
    input: number[][],
    signal?: AbortSignal,
  ) {
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, "calculator-" + randomUUID());
    await writeFile(path, binary, { mode: 0o700 });
    let r;
    try {
      r = await command(path, [], {
        input: input.map((x) => x.join(" ")).join("\n") + "\n",
        signal,
        timeoutMs: 10000,
      });
    } finally {
      await unlink(path);
    }
    if (r.code !== 0)
      throw new Error(
        `Calculator execution failed: exit ${r.code}, signal ${r.exitSignal || "none"}, ${r.stderr}`,
      );
    const rows = r.stdout.trim().split("\n").map(Number);
    if (
      rows.length !== input.length ||
      rows.some((x) => !Number.isInteger(x) || x < 0 || x > 4095)
    )
      throw new Error("Invalid executable output.");
    return rows;
  }
}
export function functionAssembly(disassembly: string) {
  const lines = disassembly.split("\n");
  const start = lines.findIndex((x) => /<_?calibrate>:/.test(x));
  if (start < 0) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[0-9a-f]+ <.+>:/.test(lines[i])) break;
    const match = lines[i].match(
      /^\s*[0-9a-f]+:\s+(?:[0-9a-f]{2,8}\s+)+(.+)$/i,
    );
    if (match) out.push(match[1].replace(/0x[0-9a-f]+/gi, "ADDR"));
  }
  return out.join("\n");
}
export function measure(
  build: Build,
  baseline: Build,
  profile: DeviceProfile,
): Measurement {
  const slowdown = build.bench.batchMs / baseline.bench.batchMs;
  const matches =
    build.output === baseline.output &&
    build.output.trim().split("\n").length === cases().length;
  const m = {
    binaryBytes: build.binary.length,
    rssBytes: build.bench.rssBytes,
    batchMs: build.bench.batchMs,
    samplesMs: build.bench.samplesMs,
    slowdown,
    differentialCases: cases().length,
    differentialSeed: 5370206,
    matches,
    limits,
    passed: false,
    assemblyChanged:
      !!functionAssembly(build.assembly) &&
      functionAssembly(build.assembly) !== functionAssembly(baseline.assembly),
  };
  m.passed =
    matches &&
    m.binaryBytes <=
      Math.min(limits.maxBinaryBytes, profile.storageMiB * 1048576) &&
    m.rssBytes <= Math.min(limits.maxRssBytes, profile.ramMiB * 1048576) &&
    m.batchMs <= Math.min(limits.maxBatchMs, profile.maxBatchMs) &&
    slowdown <= Math.min(limits.maxSlowdown, profile.maxSlowdown);
  return m;
}
export class HostedExecutor {
  kind = "hosted";
  constructor(
    private endpoint: string,
    private token: string,
  ) {
    const u = new URL(endpoint);
    if (u.protocol !== "https:")
      throw new Error("Hosted execution requires HTTPS.");
  }
  async request(action: string, payload: unknown, signal?: AbortSignal) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(
        `${this.endpoint.replace(/\/$/, "")}/v1/${action}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
            : AbortSignal.timeout(180000),
          redirect: "error",
        },
      );
      if (response.status !== 429 || attempt === 2) break;
      await response.body?.cancel();
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100 * 2 ** attempt),
      );
      signal?.throwIfAborted();
    }
    if (!response!.ok)
      throw new Error(`Hosted worker returned ${response!.status}.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response!.body! as any) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024)
        throw new Error("Hosted result is too large.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async capabilities() {
    return this.request("capabilities", {});
  }
  async prove(
    source: string,
    _dir: string,
    signal?: AbortSignal,
  ): Promise<Proof> {
    const p = await this.request("prove", { source }, signal);
    if (
      p.sourceHash !== hash(source) ||
      p.harnessHash !== hash(relationalHarness(source))
    )
      throw new Error("Hosted proof identity mismatch.");
    return p;
  }
  async build(
    source: string,
    _dir: string,
    signal?: AbortSignal,
    reproduce = false,
  ): Promise<Build> {
    const b = await this.request("build", { source, reproduce }, signal);
    b.binary = Buffer.from(b.binary, "base64");
    if (b.sourceHash !== hash(source) || b.binaryHash !== hash(b.binary))
      throw new Error("Hosted build identity mismatch.");
    return b;
  }
  async execute(
    binary: Buffer,
    _dir: string,
    input: number[][],
    signal?: AbortSignal,
  ): Promise<number[]> {
    return this.request(
      "execute",
      { binary: binary.toString("base64"), input },
      signal,
    );
  }
}
export function executor() {
  return process.env.MIRAGE_WORKER_URL && process.env.MIRAGE_WORKER_TOKEN
    ? new HostedExecutor(
        process.env.MIRAGE_WORKER_URL,
        process.env.MIRAGE_WORKER_TOKEN,
      )
    : new LocalExecutor();
}
export type Executor = LocalExecutor | HostedExecutor;
