// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

export interface PodmanProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface PodmanBackend {
  readonly networkAvailability: () => Promise<{
    readonly available: boolean;
    readonly reason?: string;
  }>;
  readonly spawn: (
    args: ReadonlyArray<string>,
    options: SpawnOptionsWithoutStdio & {
      readonly stdio: readonly ["pipe", "pipe", "pipe"];
    },
  ) => ChildProcessByStdio<Writable, Readable, Readable>;
  readonly run: (
    args: ReadonlyArray<string>,
    options?: { readonly input?: string | Uint8Array },
  ) => Promise<PodmanProcessResult>;
}

/**
 * Native Linux execution. A Windows backend can prepend `wsl.exe` and a
 * selected distribution here without changing lifecycle or tool IO.
 */
export const localPodmanBackend: PodmanBackend = {
  networkAvailability: async () => {
    try {
      const tun = await NodeFSP.open("/dev/net/tun", "r+");
      await tun.close();
      return { available: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        available: false,
        reason: `Rootless Podman networking requires a working TUN device (${message}). If the kernel was upgraded, reboot into the installed kernel.`,
      };
    }
  },
  spawn: (args, options) => spawn("podman", args, options),
  run: (args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn("podman", args, {
        stdio: [options?.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.stdin?.on("error", () => {});
      if (options?.input !== undefined) child.stdin?.end(options.input);
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    }),
};
