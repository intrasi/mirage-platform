import { createHash } from "node:crypto";
import { hash, jsonHash } from "./config.js";
export function parseGitHub(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("Use an HTTPS github.com repository URL.");
  const m = u.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..")
    throw new Error("Use a repository URL without a file path.");
  return { owner: m[1], repo: m[2] };
}
export function safeRepositoryPath(path: string) {
  return (
    path.length <= 500 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((x) => x === ".." || x === "." || !x) &&
    !path.split("/").some((part) => part.toLowerCase() === ".git")
  );
}
async function githubJson(url: string, transport: typeof fetch) {
  const r = await transport(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "mirage-demo",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok)
    throw new Error(
      `GitHub returned ${r.status}. Only public repositories are supported.`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of r.body! as any) {
    size += chunk.length;
    if (size > 15 * 1024 * 1024)
      throw new Error("Repository response exceeds the intake limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function snapshotGitHub(
  url: string,
  revision: string,
  transport: typeof fetch = fetch,
) {
  const { owner, repo } = parseGitHub(url);
  if (!/^[A-Za-z0-9_./-]{1,100}$/.test(revision))
    throw new Error("Revision has unsupported characters.");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const commit = await githubJson(
    `${base}/commits/${encodeURIComponent(revision)}`,
    transport,
  );
  if (!/^[a-f0-9]{40}$/.test(commit.sha))
    throw new Error("GitHub returned an invalid commit identity.");
  const tree = await githubJson(
    `${base}/git/trees/${commit.sha}?recursive=1`,
    transport,
  );
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 2000)
    throw new Error("Repository exceeds the demo intake limit.");
  if (!/^[a-f0-9]{40}$/.test(tree.sha))
    throw new Error("GitHub returned an invalid tree identity.");
  let bytes = 0;
  const seen = new Set<string>();
  const inventory: { path: string; sha: string; size: number; mode: string }[] =
    [];
  for (const entry of tree.tree) {
    if (
      typeof entry.path !== "string" ||
      !safeRepositoryPath(entry.path) ||
      seen.has(entry.path) ||
      !["tree", "blob"].includes(entry.type) ||
      (entry.type === "blob" && !["100644", "100755"].includes(entry.mode))
    )
      throw new Error("Repository contains unsupported paths or links.");
    seen.add(entry.path);
    if (entry.type === "tree") continue;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error("Repository contains an invalid file size.");
    bytes += entry.size;
    if (bytes > 10 * 1024 * 1024)
      throw new Error("Repository exceeds the 10 MiB intake limit.");
    if (!/^[a-f0-9]{40}$/.test(entry.sha))
      throw new Error("Repository contains an invalid blob identity.");
    inventory.push({
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
      mode: entry.mode,
    });
  }
  const files = [];
  const started = Date.now();
  for (const entry of inventory) {
    if (Date.now() - started > 60000)
      throw new Error(
        "Repository intake exceeded its one-minute download budget.",
      );
    const blob = await githubJson(`${base}/git/blobs/${entry.sha}`, transport);
    if (blob.encoding !== "base64" || typeof blob.content !== "string")
      throw new Error("GitHub returned an unsupported blob encoding.");
    const encoded = blob.content.replace(/\s/g, "");
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new Error("GitHub returned invalid file content.");
    const content = Buffer.from(encoded, "base64");
    const identity = createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex");
    if (
      content.length !== entry.size ||
      identity !== entry.sha ||
      blob.sha !== entry.sha
    )
      throw new Error("Repository blob identity mismatch.");
    files.push({ ...entry, sha256: hash(content), content: encoded });
  }
  const dependencyNames =
    /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|requirements[^/]*\.txt|pyproject\.toml|uv\.lock|go\.(mod|sum)|CMakeLists\.txt|Makefile|\.gitmodules|.*\.lock)$/i;
  const dependencies = files
    .filter((f) => dependencyNames.test(f.path))
    .map(({ path, sha256 }) => ({
      path,
      sha256,
      state: "declared; not installed or executed",
    }));
  return {
    url,
    commit: commit.sha,
    tree: tree.sha,
    inventory,
    files,
    sourceHash: jsonHash(
      files.map(({ path, mode, sha256 }) => ({ path, mode, sha256 })),
    ),
    dependencies,
    dependencyScope:
      "Declared manifests and lockfiles. Transitive dependencies are not resolved.",
    declaredBytes: bytes,
    executionSupported: false,
    gap: "Source snapshot imported. Arbitrary repository execution requires a reviewed isolation and build adapter.",
  };
}
