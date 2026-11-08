import { mkdir, writeFile } from "node:fs/promises";
import { snapshotGitHub } from "../server/github.js";
const snapshot = await snapshotGitHub(
  "https://github.com/octocat/Hello-World",
  "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
);
await mkdir(".data/intake-verification", { recursive: true });
await writeFile(
  ".data/intake-verification/snapshot.json",
  JSON.stringify(snapshot, null, 2),
);
console.log(
  JSON.stringify(
    {
      commit: snapshot.commit,
      sourceHash: snapshot.sourceHash,
      files: snapshot.files.length,
      bytes: snapshot.declaredBytes,
      dependencyManifests: snapshot.dependencies.length,
      executionSupported: snapshot.executionSupported,
    },
    null,
    2,
  ),
);
