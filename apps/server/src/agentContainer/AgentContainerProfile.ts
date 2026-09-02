// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

const ResourceInput = Schema.Struct({
  id: Schema.String,
  source: Schema.optional(Schema.String),
  target: Schema.String,
  sharing: Schema.optional(Schema.Literals(["global", "project"])),
  readOnly: Schema.optional(Schema.Boolean),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const ProfileInput = Schema.Struct({
  image: Schema.optional(Schema.String),
  resources: Schema.optional(Schema.Array(ResourceInput)),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

interface ResourceDefinition {
  readonly id: string;
  readonly source?: string;
  readonly target: string;
  readonly sharing: "global" | "project";
  readonly readOnly: boolean;
  readonly environment: Readonly<Record<string, string>>;
}

export interface AgentContainerResource extends ResourceDefinition {
  readonly source: string;
}

export interface AgentContainerProfile {
  readonly image: string;
  readonly resources: ReadonlyArray<AgentContainerResource>;
  readonly environment: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}

const BASE_PATH =
  "/t3/tools/bin:/t3/tools/pnpm:/t3/tools/cargo/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const DEFAULT_RESOURCES: ReadonlyArray<ResourceDefinition> = [
  {
    id: "package-cache",
    target: "/t3/worktrees/.t3-container-resources/package-cache",
    sharing: "project",
    readOnly: false,
    environment: {
      XDG_CACHE_HOME: "/t3/worktrees/.t3-container-resources/package-cache/xdg",
      npm_config_cache: "/t3/worktrees/.t3-container-resources/package-cache/npm",
      pnpm_config_store_dir: "/t3/worktrees/.t3-container-resources/package-cache/pnpm",
      pnpm_config_package_import_method: "auto",
      PIP_CACHE_DIR: "/t3/worktrees/.t3-container-resources/package-cache/pip",
      GOCACHE: "/t3/worktrees/.t3-container-resources/package-cache/go/build",
      GOMODCACHE: "/t3/worktrees/.t3-container-resources/package-cache/go/mod",
    },
  },
  {
    id: "toolchains",
    target: "/t3/tools",
    sharing: "global",
    readOnly: false,
    environment: {
      PATH: BASE_PATH,
      PNPM_HOME: "/t3/tools/pnpm",
      COREPACK_HOME: "/t3/tools/corepack",
      CARGO_HOME: "/t3/tools/cargo",
    },
  },
];

function normalizeResource(
  input: typeof ResourceInput.Type,
  source: string,
  allowHostSource: boolean,
): ResourceDefinition {
  const id = input.id.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error(
      `${source}: resource id '${input.id}' must use lowercase letters, digits, '.', '_' or '-'.`,
    );
  }
  const target = NodePath.posix.normalize(input.target.trim());
  if (!target.startsWith("/") || target === "/") {
    throw new Error(`${source}: resource '${id}' target must be an absolute container path.`);
  }
  if (
    target === "/workspace" ||
    target.startsWith("/workspace/") ||
    target === "/t3/worktrees" ||
    target.startsWith("/t3/worktrees/") ||
    ["/dev", "/proc", "/sys"].some(
      (reserved) => target === reserved || target.startsWith(`${reserved}/`),
    )
  ) {
    throw new Error(`${source}: resource '${id}' target '${target}' overlaps a reserved mount.`);
  }
  const hostSource = input.source?.trim();
  if (hostSource && !allowHostSource) {
    throw new Error(
      `${source}: project profiles cannot expose host paths; declare resource '${id}' in the global profile instead.`,
    );
  }
  if (
    hostSource &&
    (!NodePath.isAbsolute(hostSource) || NodePath.parse(hostSource).root === hostSource)
  ) {
    throw new Error(`${source}: resource '${id}' source must be a specific absolute host path.`);
  }
  for (const key of Object.keys(input.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${source}: resource '${id}' has invalid environment key '${key}'.`);
    }
  }
  return {
    id,
    ...(hostSource ? { source: NodePath.normalize(hostSource) } : {}),
    target,
    sharing: input.sharing ?? "project",
    readOnly: input.readOnly ?? false,
    environment: input.environment ?? {},
  };
}

async function readProfile(path: string): Promise<typeof ProfileInput.Type | undefined> {
  let contents: string;
  try {
    contents = await NodeFSP.readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    return Schema.decodeUnknownSync(ProfileInput)(JSON.parse(contents));
  } catch (cause) {
    throw new Error(`Invalid agent container profile '${path}': ${String(cause)}`, { cause });
  }
}

function mergeResources(
  profiles: ReadonlyArray<{
    readonly path: string;
    readonly profile: typeof ProfileInput.Type | undefined;
    readonly allowHostSource: boolean;
  }>,
): ReadonlyArray<ResourceDefinition> {
  const resources = new Map(DEFAULT_RESOURCES.map((resource) => [resource.id, resource]));
  for (const { path, profile, allowHostSource } of profiles) {
    for (const input of profile?.resources ?? []) {
      const resource = normalizeResource(input, path, allowHostSource);
      resources.set(resource.id, resource);
    }
  }
  const values = [...resources.values()];
  const targets = new Map<string, string>();
  for (const resource of values) {
    const existing = targets.get(resource.target);
    if (existing) {
      throw new Error(
        `Agent container resources '${existing}' and '${resource.id}' use the same target '${resource.target}'.`,
      );
    }
    targets.set(resource.target, resource.id);
  }
  return values;
}

export async function resolveAgentContainerProfile(input: {
  readonly stateDir: string;
  readonly projectPath: string;
  readonly projectResourceRoot: string;
  readonly defaultImage: string;
}): Promise<AgentContainerProfile> {
  const globalPath = NodePath.join(input.stateDir, "agent-container-profile.json");
  const projectPath = NodePath.join(input.projectPath, ".t3code", "container.json");
  const profiles = [
    { path: globalPath, profile: await readProfile(globalPath), allowHostSource: true },
    { path: projectPath, profile: await readProfile(projectPath), allowHostSource: false },
  ] as const;
  const definitions = mergeResources(profiles);
  const resources = definitions.map(
    (resource): AgentContainerResource => ({
      ...resource,
      source:
        resource.source ??
        (resource.sharing === "global"
          ? NodePath.join(input.stateDir, "agent-container-resources", "global", resource.id)
          : NodePath.join(input.projectResourceRoot, resource.id)),
    }),
  );
  const environment = Object.assign(
    {},
    ...resources.map((resource) => resource.environment),
    ...profiles.map(({ profile }) => profile?.environment ?? {}),
  ) as Record<string, string>;
  for (const key of Object.keys(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Agent container profile has invalid environment key '${key}'.`);
    }
  }
  const image =
    [...profiles]
      .reverse()
      .find(({ profile }) => profile?.image?.trim())
      ?.profile?.image?.trim() ?? input.defaultImage;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ image, resources, environment }))
    .digest("hex");
  return { image, resources, environment, fingerprint };
}
