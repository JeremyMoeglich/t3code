// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics cryptoRandomUUID:off
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function expandHome(path: string): string {
  if (path === "~") return NodeOS.homedir();
  return path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(2)) : path;
}

function asCredential(value: unknown): Credential | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    if (candidate.key !== undefined && typeof candidate.key !== "string") return undefined;
    if (
      candidate.env !== undefined &&
      (candidate.env === null || typeof candidate.env !== "object" || Array.isArray(candidate.env))
    ) {
      return undefined;
    }
    return candidate as unknown as Credential;
  }
  if (
    candidate.type === "oauth" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.access === "string" &&
    typeof candidate.expires === "number"
  ) {
    return candidate as unknown as Credential;
  }
  return undefined;
}

async function readCredentials(path: string): Promise<Record<string, Credential>> {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([providerId, value]) => {
        const credential = asCredential(value);
        return credential ? [[providerId, credential] as const] : [];
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function makePiCredentialStore(authPath: string): CredentialStore {
  const path = expandHome(authPath);
  let lock: Promise<void> = Promise.resolve();

  const writeCredentials = async (credentials: Record<string, Credential>): Promise<void> => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
        mode: 0o600,
      });
      await NodeFSP.rename(temporaryPath, path);
      await NodeFSP.chmod(path, 0o600);
    } finally {
      await NodeFSP.unlink(temporaryPath).catch(() => undefined);
    }
  };

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = lock;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    lock = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return {
    read: async (providerId, options?: AuthOperationOptions) => {
      options?.signal?.throwIfAborted();
      return (await readCredentials(path))[providerId];
    },
    list: async (options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> => {
      options?.signal?.throwIfAborted();
      const credentials = await readCredentials(path);
      return Object.entries(credentials).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    modify: (providerId, fn, options?: AuthOperationOptions) =>
      serialized(async () => {
        options?.signal?.throwIfAborted();
        const credentials = await readCredentials(path);
        const next = await fn(credentials[providerId]);
        options?.signal?.throwIfAborted();
        if (next === undefined) return credentials[providerId];
        credentials[providerId] = next;
        await writeCredentials(credentials);
        return next;
      }),
    delete: (providerId, options?: AuthOperationOptions) =>
      serialized(async () => {
        options?.signal?.throwIfAborted();
        const credentials = await readCredentials(path);
        if (!(providerId in credentials)) return;
        delete credentials[providerId];
        await writeCredentials(credentials);
      }),
  };
}
