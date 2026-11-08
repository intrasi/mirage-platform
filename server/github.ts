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
    !path.startsWith(".git/")
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
    if (size > 5 * 1024 * 1024)
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
  let bytes = 0;
  const inventory = tree.tree
    .filter((x: any) => x.type === "blob")
    .map((x: any) => {
      if (
        !safeRepositoryPath(x.path) ||
        x.mode === "120000" ||
        x.mode === "160000"
      )
        throw new Error("Repository contains unsupported paths or links.");
      bytes += Number(x.size) || 0;
      return { path: x.path, sha: x.sha, size: x.size, mode: x.mode };
    });
  if (bytes > 10 * 1024 * 1024)
    throw new Error("Repository exceeds the 10 MiB intake limit.");
  return {
    url,
    commit: commit.sha,
    tree: tree.sha,
    inventory,
    declaredBytes: bytes,
    executionSupported: false,
    gap: "Repository metadata is imported. Arbitrary repository execution requires a reviewed isolation and build adapter.",
  };
}
