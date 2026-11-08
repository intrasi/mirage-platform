import { mkdir, copyFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { command } from "../server/process.js";
const target = resolve(".data/sample-repository");
await mkdir(target, { recursive: true });
for (const file of [
  "calibrate.c",
  "runner.c",
  "Makefile",
  "README.md",
  "mirage.json",
])
  await copyFile(resolve("sample", file), resolve(target, file));
const initialized = await access(resolve(target, ".git"))
  .then(() => true)
  .catch(() => false);
if (!initialized) {
  for (const args of [
    ["init", "--initial-branch=main"],
    ["add", "."],
    [
      "-c",
      "user.name=Mirage Demo",
      "-c",
      "user.email=demo@example.invalid",
      "commit",
      "-m",
      "Add fictional calibration sample",
    ],
  ]) {
    const result = await command("git", args, { cwd: target });
    if (result.code !== 0) throw new Error(result.stderr);
  }
}
const commit = await command("git", ["rev-parse", "HEAD"], { cwd: target });
console.log(
  `Local sample repository: ${target}\nCommit: ${commit.stdout.trim()}`,
);
