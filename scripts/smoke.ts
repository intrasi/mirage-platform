import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { workspaceToken, hash, dataDir } from "../server/config.js";
import { command } from "../server/process.js";
const base = process.env.MIRAGE_TEST_URL || "http://127.0.0.1:4184";
const token = workspaceToken();
async function api(path: string, body?: unknown) {
  const r = await fetch(base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const capabilities = await api("/capabilities");
const project = await api("/projects", {
  name: "Verified local demonstration",
  source: "sample",
});
const run = await api("/runs", {
  projectId: project.id,
  profile: capabilities.profiles[0],
  policy: { maxAttempts: 3 },
});
const events: any[] = [];
const controller = new AbortController();
const response = await fetch(base + `/api/runs/${run.id}/events`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
});
if (!response.ok) throw new Error("Event stream connection failed.");
const reader = response.body!.getReader();
let buffer = "";
let complete = false;
while (!complete) {
  const chunk = await reader.read();
  if (chunk.done) break;
  buffer += new TextDecoder().decode(chunk.value);
  const blocks = buffer.split("\n\n");
  buffer = blocks.pop() || "";
  for (const block of blocks) {
    const line = block.split("\n").find((x) => x.startsWith("data: "));
    if (!line) continue;
    const event = JSON.parse(line.slice(6));
    events.push(event);
    if (["succeeded", "failed", "cancelled"].includes(event.stage))
      complete = true;
  }
}
await reader.cancel();
const final = await api(`/runs/${run.id}`);
if (final.state !== "succeeded") throw new Error(final.error || final.state);
const candidate = final.candidates.find((c: any) => c.id === final.acceptedId);
const calculation = await api(`/runs/${run.id}/calculate`, {
  raw: 812,
  gain_q8: 300,
  offset: -21,
});
if (!calculation.matches || calculation.original !== 931)
  throw new Error("Fresh executable comparison failed.");
const destination = resolve(dataDir, "demo-export");
await mkdir(destination, { recursive: true, mode: 0o700 });
const packages: Record<string, string> = {};
for (const [kind, id] of Object.entries(final.artifacts)) {
  const r = await fetch(base + `/api/artifacts/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("Artifact download failed.");
  const bytes = Buffer.from(await r.arrayBuffer());
  if (hash(bytes) !== r.headers.get("x-artifact-sha256"))
    throw new Error("Download hash mismatch.");
  const name = r.headers
    .get("content-disposition")
    ?.match(/filename="([^"]+)"/)?.[1];
  if (!name || name.includes("/"))
    throw new Error("Invalid download filename.");
  await writeFile(resolve(destination, name), bytes, { mode: 0o600 });
  packages[kind] = resolve(destination, name);
}
for (const kind of ["source", "executable"]) {
  const unpack = resolve(destination, kind);
  await mkdir(unpack, { recursive: true });
  const result = await command("tar", ["-xzf", packages[kind], "-C", unpack]);
  if (result.code !== 0) throw new Error("Archive inspection failed.");
  const manifest = JSON.parse(
    await readFile(resolve(unpack, "manifest.json"), "utf8"),
  );
  if (
    manifest.candidateId !== final.acceptedId ||
    manifest.binaryHash !== candidate.binaryHash
  )
    throw new Error("Package identity mismatch.");
  if (
    kind === "source" &&
    hash(await readFile(resolve(unpack, "calibrate.c"))) !==
      candidate.sourceHash
  )
    throw new Error("Packaged source hash mismatch.");
  if (kind === "executable") {
    const binary = await readFile(resolve(unpack, "calculator"));
    if (hash(binary) !== candidate.binaryHash)
      throw new Error("Packaged binary hash mismatch.");
    const result = await command(resolve(unpack, "calculator"), [], {
      input: "812 300 -21\n",
    });
    if (result.stdout.trim() !== "931")
      throw new Error("Downloaded executable failed.");
  }
}
const report = {
  verifiedAt: new Date().toISOString(),
  runId: run.id,
  target: final.baseline.target,
  compiler: final.baseline.compiler,
  proof: candidate.proof.state,
  proofTool: candidate.proof.version,
  measurement: candidate.measurement,
  eventCount: events.length,
  lastEvent: events.at(-1),
  calculation,
  packages,
  gaps: final.gaps,
  reconstruction: final.reconstruction,
};
await writeFile(
  resolve(dataDir, "smoke-result.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
