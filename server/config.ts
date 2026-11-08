import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
export const root = resolve(process.env.MIRAGE_ROOT || process.cwd());
export const dataDir = resolve(
  process.env.MIRAGE_DATA || resolve(root, ".data"),
);
export function hash(v: string | Buffer) {
  return createHash("sha256").update(v).digest("hex");
}
export function jsonHash(v: unknown) {
  return hash(JSON.stringify(v));
}
export function initDirectories() {
  for (const d of [
    dataDir,
    resolve(dataDir, "artifacts"),
    resolve(dataDir, "work"),
  ]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}
export function workspaceToken() {
  initDirectories();
  const p = resolve(dataDir, "access-token");
  if (!existsSync(p))
    writeFileSync(p, randomBytes(24).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  return readFileSync(p, "utf8").trim();
}
export const cbmcPath =
  process.env.CBMC_PATH || resolve(root, ".tools/cbmc/6.11.0/bin/cbmc");
export const clangPath = process.env.CLANG_PATH || "clang";
