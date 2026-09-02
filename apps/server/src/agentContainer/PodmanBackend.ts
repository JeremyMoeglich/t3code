// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface PodmanProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface PodmanBackend {
  readonly spawn: (
    args: ReadonlyArray<string>,
    options: SpawnOptionsWithoutStdio & {
      readonly stdio: readonly ["pipe", "pipe", "pipe"];
    },
  ) => ChildProcessByStdio<Writable, Readable, Readable>;
  readonly run: (args: ReadonlyArray<string>) => Promise<PodmanProcessResult>;
}

/**
 * Native Linux execution. A Windows backend can prepend `wsl.exe` and a
 * selected distribution here without changing lifecycle or tool IO.
 */
export const localPodmanBackend: PodmanBackend = {
  spawn: (args, options) => spawn("podman", args, options),
  run: (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    }),
};
