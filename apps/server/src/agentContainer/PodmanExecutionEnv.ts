// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import * as NodePath from "node:path";

import { localPodmanBackend, type PodmanBackend } from "./PodmanBackend.ts";
import {
  hostPortForwarder,
  type ExposedContainerPort,
  type HostPortForwarder,
} from "./HostPortForwarder.ts";

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
  readonly termination?: "aborted" | "timeout";
  readonly callbackError?: Error;
}

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;

const PYTHON_FS = String.raw`
import base64,json,os,shutil,stat,sys,tempfile
r=json.loads(sys.argv[1]); op=r["op"]
def info(p):
 s=os.lstat(p); m=s.st_mode
 return {"name":os.path.basename(p),"path":p,"kind":"symlink" if stat.S_ISLNK(m) else "directory" if stat.S_ISDIR(m) else "file","size":s.st_size,"mtimeMs":s.st_mtime_ns/1000000}
if op=="read": sys.stdout.buffer.write(open(r["path"],"rb").read())
elif op=="write":
 os.makedirs(os.path.dirname(r["path"]),exist_ok=True); open(r["path"],"wb").write(base64.b64decode(r["data"]))
elif op=="append":
 os.makedirs(os.path.dirname(r["path"]),exist_ok=True); open(r["path"],"ab").write(base64.b64decode(r["data"]))
elif op=="rename": os.replace(r["source"],r["destination"])
elif op=="info": print(json.dumps(info(r["path"])))
elif op=="list": print(json.dumps([info(os.path.join(r["path"],n)) for n in os.listdir(r["path"])]))
elif op=="realpath": print(os.path.realpath(r["path"]),end="")
elif op=="exists": print("true" if os.path.lexists(r["path"]) else "false",end="")
elif op=="mkdir": os.makedirs(r["path"],exist_ok=r["recursive"])
elif op=="remove":
 p=r["path"]
 if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p) if r["recursive"] else os.rmdir(p)
 else:
  try: os.unlink(p)
  except FileNotFoundError:
   if not r["force"]: raise
elif op=="tempdir": print(tempfile.mkdtemp(prefix=r["prefix"]),end="")
elif op=="tempfile":
 fd,p=tempfile.mkstemp(prefix=r["prefix"],suffix=r["suffix"]); os.close(fd); print(p,end="")
`;

function fileError(path: string, stderr: Buffer): FileError {
  const message = stderr.toString("utf8").trim() || `Container file operation failed for ${path}`;
  const lower = message.toLowerCase();
  const code = lower.includes("no such file")
    ? "not_found"
    : lower.includes("permission denied")
      ? "permission_denied"
      : lower.includes("not a directory")
        ? "not_directory"
        : lower.includes("is a directory")
          ? "is_directory"
          : "unknown";
  return new FileError(code, message, path);
}

export class PodmanExecutionEnv implements ExecutionEnv {
  readonly cwd = "/workspace";
  private readonly containerName: string;
  private readonly podman: PodmanBackend;
  private readonly defaultEnv: Readonly<Record<string, string>>;
  private readonly portForwarder: HostPortForwarder;
  private readonly activeCommands = new Set<ReturnType<PodmanBackend["spawn"]>>();

  constructor(
    containerName: string,
    podman: PodmanBackend = localPodmanBackend,
    defaultEnv: Readonly<Record<string, string>> = {},
    portForwarder: HostPortForwarder = hostPortForwarder,
  ) {
    this.containerName = containerName;
    this.podman = podman;
    this.defaultEnv = defaultEnv;
    this.portForwarder = portForwarder;
  }

  exposePort(containerPort: number): Promise<ExposedContainerPort> {
    return this.portForwarder.expose(this.containerName, containerPort, this.podman);
  }

  private run(
    podmanOptions: ReadonlyArray<string>,
    command: ReadonlyArray<string>,
    options: {
      readonly stdin?: Uint8Array;
      readonly abortSignal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly onStdout?: (chunk: string) => void;
      readonly onStderr?: (chunk: string) => void;
    } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.podman.spawn(["exec", ...podmanOptions, this.containerName, ...command], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.activeCommands.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let termination: CommandResult["termination"];
      let callbackError: Error | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", abort);
        this.activeCommands.delete(child);
        callback();
      };
      const abort = () => {
        termination = "aborted";
        child.kill("SIGTERM");
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            termination = "timeout";
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : undefined;
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        try {
          options.onStdout?.(chunk.toString("utf8"));
        } catch (cause) {
          callbackError = cause instanceof Error ? cause : new Error(String(cause));
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        try {
          options.onStderr?.(chunk.toString("utf8"));
        } catch (cause) {
          callbackError = cause instanceof Error ? cause : new Error(String(cause));
          child.kill("SIGTERM");
        }
      });
      child.on("error", (cause) => finish(() => reject(cause)));
      child.on("close", (code) =>
        finish(() =>
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            exitCode: code ?? 1,
            ...(termination ? { termination } : {}),
            ...(callbackError ? { callbackError } : {}),
          }),
        ),
      );
      if (options.stdin) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }

  private path(path: string): string {
    return NodePath.posix.resolve(this.cwd, path);
  }

  private async fs<T>(
    path: string,
    request: Record<string, unknown>,
    decode: (stdout: Buffer) => T,
    abortSignal?: AbortSignal,
  ): Promise<Result<T, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", path));
    try {
      const result = await this.run(
        ["--workdir", this.cwd],
        ["python3", "-c", PYTHON_FS, JSON.stringify(request)],
        abortSignal ? { abortSignal } : {},
      );
      if (abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", path));
      return result.exitCode === 0
        ? ok(decode(result.stdout))
        : err(fileError(path, result.stderr));
    } catch (cause) {
      return err(
        new FileError(
          "unknown",
          `Container file operation failed for ${path}`,
          path,
          cause as Error,
        ),
      );
    }
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.path(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(NodePath.posix.resolve(this.cwd, NodePath.posix.join(...parts)));
  }

  readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      { op: "read", path: absolute },
      (value) => value.toString("utf8"),
      abortSignal,
    );
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number; abortSignal?: AbortSignal } = {},
  ): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(path, options.abortSignal);
    if (!result.ok) return result;
    const lines = result.value.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return ok(options.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const absolute = this.path(path);
    return this.fs(absolute, { op: "read", path: absolute }, (value) => value, abortSignal);
  }

  private write(
    op: "write" | "append",
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const absolute = this.path(path);
    const data = Buffer.from(content).toString("base64");
    return this.fs(absolute, { op, path: absolute, data }, () => undefined, abortSignal);
  }

  writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    return this.write("write", path, content, abortSignal);
  }

  appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    return this.write("append", path, content, abortSignal);
  }

  renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal) {
    const source = this.path(sourcePath);
    const destination = this.path(destinationPath);
    return this.fs(source, { op: "rename", source, destination }, () => undefined, abortSignal);
  }

  fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      { op: "info", path: absolute },
      (value) => JSON.parse(value.toString("utf8")),
      abortSignal,
    );
  }

  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      { op: "list", path: absolute },
      (value) => JSON.parse(value.toString("utf8")),
      abortSignal,
    );
  }

  canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      { op: "realpath", path: absolute },
      (value) => value.toString("utf8"),
      abortSignal,
    );
  }

  exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      { op: "exists", path: absolute },
      (value) => value.toString("utf8") === "true",
      abortSignal,
    );
  }

  createDir(path: string, options: { recursive?: boolean; abortSignal?: AbortSignal } = {}) {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      { op: "mkdir", path: absolute, recursive: options.recursive ?? true },
      () => undefined,
      options.abortSignal,
    );
  }

  remove(
    path: string,
    options: {
      recursive?: boolean;
      force?: boolean;
      abortSignal?: AbortSignal;
    } = {},
  ) {
    const absolute = this.path(path);
    return this.fs(
      absolute,
      {
        op: "remove",
        path: absolute,
        recursive: options.recursive ?? false,
        force: options.force ?? false,
      },
      () => undefined,
      options.abortSignal,
    );
  }

  createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fs(
      this.cwd,
      { op: "tempdir", prefix },
      (value) => value.toString("utf8"),
      abortSignal,
    );
  }

  createTempFile(
    options: {
      prefix?: string;
      suffix?: string;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<Result<string, FileError>> {
    return this.fs(
      this.cwd,
      {
        op: "tempfile",
        prefix: options.prefix ?? "",
        suffix: options.suffix ?? "",
      },
      (value) => value.toString("utf8"),
      options.abortSignal,
    );
  }

  async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) ||
        options.timeout <= 0 ||
        options.timeout > MAX_TIMEOUT_SECONDS)
    ) {
      return err(
        new ExecutionError(
          "timeout",
          `Invalid timeout: must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds`,
        ),
      );
    }
    const cwd = this.path(options.cwd ?? this.cwd);
    const environment =
      options.inheritEnv === false ? (options.env ?? {}) : { ...this.defaultEnv, ...options.env };
    const envArgs = Object.entries(environment).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    try {
      const result = await this.run(["--workdir", cwd, ...envArgs], ["/bin/bash", "-lc", command], {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout * 1_000 }),
        ...(options.onStdout ? { onStdout: options.onStdout } : {}),
        ...(options.onStderr ? { onStderr: options.onStderr } : {}),
      });
      if (result.callbackError) {
        return err(
          new ExecutionError("callback_error", result.callbackError.message, result.callbackError),
        );
      }
      if (result.termination === "timeout") {
        return err(new ExecutionError("timeout", `timeout:${options.timeout}`));
      }
      if (options.abortSignal?.aborted)
        return err(new ExecutionError("aborted", "Command aborted"));
      return ok({
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        exitCode: result.exitCode,
      });
    } catch (cause) {
      return err(
        new ExecutionError(
          "spawn_error",
          "Could not execute command in the Podman container",
          cause as Error,
        ),
      );
    }
  }

  async cleanup(): Promise<void> {
    for (const command of this.activeCommands) command.kill("SIGTERM");
    this.activeCommands.clear();
  }
}
