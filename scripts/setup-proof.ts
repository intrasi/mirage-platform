import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = process.cwd(),
  tools = resolve(root, ".tools");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(
    "Set CBMC_PATH to CBMC 6.11.0 on this host. The pinned bottle supports macOS ARM64.",
  );
await mkdir(tools, { recursive: true });
const cache = resolve(tools, "cache");
const f = spawnSync(
  "brew",
  ["fetch", "--force", "--bottle-tag=arm64_tahoe", "cbmc"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_CACHE: cache,
    },
  },
);
if (f.status !== 0) process.exit(1);
const file = (await readdir(resolve(cache, "downloads"))).find((x) =>
  x.endsWith("cbmc--6.11.0.arm64_tahoe.bottle.tar.gz"),
);
if (!file) throw new Error("Pinned CBMC bottle is unavailable.");
const archive = resolve(cache, "downloads", file);
const digest = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
if (
  digest !== "3fb094c69d4a877d89c3471c0c0adff0526220261e593f7ffb6f13d4224129f8"
)
  throw new Error("CBMC bottle hash mismatch.");
const t = spawnSync("tar", ["-xzf", archive, "-C", tools], {
  stdio: "inherit",
});
if (t.status !== 0) process.exit(1);
const v = spawnSync(resolve(tools, "cbmc/6.11.0/bin/cbmc"), ["--version"], {
  encoding: "utf8",
});
if (v.status !== 0) throw new Error(v.stderr);
console.log(
  `Installed project-local CBMC ${v.stdout.trim()}. Verified SHA-256 ${digest}.`,
);
const z3Archive = resolve(tools, "z3.zip");
const z = spawnSync(
  "curl",
  [
    "--fail",
    "--location",
    "--output",
    z3Archive,
    "https://github.com/Z3Prover/z3/releases/download/z3-5.3.3/z3-5.3.3-arm64-osx-13.3.zip",
  ],
  { stdio: "inherit" },
);
if (z.status !== 0) process.exit(1);
const zDigest = createHash("sha256")
  .update(await readFile(z3Archive))
  .digest("hex");
if (
  zDigest !== "6957e6c75266d7ca8fa77030e86e83d78624567dcdf34cc11f4192fdc6f93c6b"
)
  throw new Error("Z3 archive hash mismatch.");
const unzip = spawnSync("unzip", ["-oq", z3Archive, "-d", tools], {
  stdio: "inherit",
});
if (unzip.status !== 0) process.exit(1);
const zv = spawnSync(
  resolve(tools, "z3-5.3.3-arm64-osx-13.3/bin/z3"),
  ["--version"],
  { encoding: "utf8" },
);
if (zv.status !== 0) throw new Error(zv.stderr);
console.log(zv.stdout.trim());
