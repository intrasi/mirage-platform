import { spawn } from "node:child_process";
import { resolve as resolvePath, delimiter } from "node:path";
export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  exitSignal?: string;
};
export function command(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxBytes?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let stdout = "",
      stderr = "",
      size = 0,
      timedOut = false,
      settled = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: {
        PATH: [
          process.env.Z3_BIN_DIR ||
            resolvePath(
              process.env.MIRAGE_ROOT || process.cwd(),
              ".tools/z3-5.3.3-arm64-osx-13.3/bin",
            ),
          process.env.PATH,
        ].join(delimiter),
        TMPDIR: process.env.TMPDIR,
        LANG: "C",
        LC_ALL: "C",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 60000);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) kill();
    const clean = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clean();
        reject(e);
      }
    });
    const collect = (kind: "out" | "err", b: Buffer) => {
      size += b.length;
      if (size > (options.maxBytes ?? 4 * 1024 * 1024)) {
        kill();
        return;
      }
      if (kind === "out") stdout += b.toString();
      else stderr += b.toString();
    };
    child.stdout.on("data", (b) => collect("out", b));
    child.stderr.on("data", (b) => collect("err", b));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clean();
      if (options.signal?.aborted)
        return reject(new Error("Operation cancelled."));
      if (size > (options.maxBytes ?? 4 * 1024 * 1024))
        return reject(new Error("Tool output exceeded its limit."));
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        durationMs: performance.now() - start,
        timedOut,
        exitSignal: exitSignal || undefined,
      });
    });
  });
}
