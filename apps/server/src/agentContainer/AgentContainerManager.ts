// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDateInEffect:off
import {
  type AgentContainerConfiguration,
  type AgentContainerConfigureInput,
  AgentContainerError,
  AgentContainerId,
  AgentContainerImageId,
  DEFAULT_AGENT_CONTAINER_IMAGE_ID,
  type AgentContainerListResult,
  type AgentContainerSummary,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  type AgentContainerProfile,
  resolveAgentContainerProfile,
} from "./AgentContainerProfile.ts";
import { type AgentContainerImage, listAgentContainerImages } from "./AgentContainerImages.ts";
import { PodmanExecutionEnv } from "./PodmanExecutionEnv.ts";
import { localPodmanBackend, type PodmanBackend } from "./PodmanBackend.ts";
import { expandDnsRules, parseNetworkPolicy, renderNftables } from "./NetworkPolicy.ts";

const MANAGED_LABEL = "dev.t3code.agent-container";
const ID_LABEL = "dev.t3code.agent-container.id";
const WORKSPACE_LABEL = "dev.t3code.agent-container.workspace";
const PROFILE_LABEL = "dev.t3code.agent-container.profile";
const DEFAULT_IMAGE = "localhost/t3code-agent-base:3";
const CONFIG_VERSION = 1;

const CONTAINERFILE = `FROM docker.io/library/node:24-bookworm-slim AS node
FROM docker.io/library/rust:1-slim-bookworm
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
  bash build-essential ca-certificates coreutils curl fd-find file findutils git jq less \\
  procps python3 python3-pip ripgrep tree unzip zip \\
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global corepack && corepack enable
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;

const InspectContainer = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Created: Schema.String,
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.Record(Schema.String, Schema.String),
  }),
  HostConfig: Schema.Struct({ NetworkMode: Schema.String }),
  ResolvConfPath: Schema.String,
  State: Schema.Struct({ Status: Schema.String, Pid: Schema.Number }),
});

const StoredConfiguration = Schema.Struct({
  version: Schema.Literal(CONFIG_VERSION),
  id: AgentContainerId,
  workspacePath: Schema.String,
  networkPolicy: Schema.String,
  imageId: Schema.optional(AgentContainerImageId),
  createdAt: Schema.optional(Schema.String),
});
const StoredConfigurationJson = Schema.fromJsonString(StoredConfiguration);
const encodeStoredConfiguration = Schema.encodeSync(StoredConfigurationJson);
const decodeStoredConfiguration = Schema.decodeUnknownEffect(StoredConfigurationJson);
const decodeStoredConfigurationSync = Schema.decodeUnknownSync(StoredConfigurationJson);
const decodeInspectContainers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(InspectContainer)),
);

function error(operation: AgentContainerError["operation"], message: string) {
  return new AgentContainerError({
    operation,
    message: message.trim() || "Podman operation failed",
  });
}

function status(value: string): AgentContainerSummary["status"] {
  if (value === "running") return "running";
  if (value === "created" || value === "configured") return "created";
  if (value === "exited" || value === "stopped") return "stopped";
  return "error";
}

function toSummary(
  value: typeof InspectContainer.Type,
  configuration: AgentContainerConfiguration,
): AgentContainerSummary | undefined {
  const id = value.Config.Labels[ID_LABEL];
  const workspacePath = value.Config.Labels[WORKSPACE_LABEL];
  if (!id || !workspacePath) return undefined;
  return {
    id: AgentContainerId.make(id),
    name: value.Name.replace(/^\//, ""),
    workspacePath,
    image: value.Config.Image,
    ...(configuration.imageId ? { imageId: configuration.imageId } : {}),
    networkPolicy: configuration.networkPolicy,
    status: status(value.State.Status),
    createdAt: value.Created,
  };
}

export class AgentContainerManager extends Context.Service<
  AgentContainerManager,
  {
    readonly list: () => Effect.Effect<AgentContainerListResult, AgentContainerError>;
    readonly configure: (
      input: AgentContainerConfigureInput,
    ) => Effect.Effect<AgentContainerConfiguration, AgentContainerError>;
    readonly executionEnvironment: (input: {
      readonly id: AgentContainerId;
      readonly workspacePath: string;
    }) => Effect.Effect<PodmanExecutionEnv, AgentContainerError>;
  }
>()("t3/agentContainer/AgentContainerManager") {}

export function makeAgentContainerManager(
  config: ServerConfig["Service"],
  podman: PodmanBackend = localPodmanBackend,
) {
  const defaultImage = process.env.T3CODE_AGENT_CONTAINER_IMAGE?.trim() || DEFAULT_IMAGE;
  const configurationDirectory = NodePath.join(config.stateDir, "agent-containers");
  const imagesDirectory = NodePath.join(config.baseDir, "container-images");

  const configurationPath = (id: AgentContainerId) =>
    NodePath.join(configurationDirectory, `${Buffer.from(String(id)).toString("base64url")}.json`);
  const containerName = (id: AgentContainerId) =>
    `t3-agent-${String(id)
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 48)}`;
  const worktreeSourceForProject = (projectPath: string) =>
    NodePath.join(config.worktreesDir, NodePath.basename(projectPath));

  const networkAvailability = Effect.fn("AgentContainerManager.networkAvailability")(function* (
    operation: AgentContainerError["operation"],
  ) {
    return yield* Effect.tryPromise({
      try: () => podman.networkAvailability(),
      catch: (cause) => error(operation, cause instanceof Error ? cause.message : String(cause)),
    });
  });

  const listImages = Effect.fn("AgentContainerManager.listImages")(function* (
    operation: AgentContainerError["operation"],
  ) {
    return yield* Effect.tryPromise({
      try: () => listAgentContainerImages(imagesDirectory),
      catch: (cause) => error(operation, cause instanceof Error ? cause.message : String(cause)),
    });
  });

  const resolveProfile = Effect.fn("AgentContainerManager.resolveProfile")(function* (
    projectPath: string,
    operation: AgentContainerError["operation"],
  ) {
    return yield* Effect.tryPromise({
      try: () =>
        resolveAgentContainerProfile({
          stateDir: config.stateDir,
          projectPath,
          projectResourceRoot: NodePath.join(
            worktreeSourceForProject(projectPath),
            ".t3-container-resources",
          ),
          defaultImage,
        }),
      catch: (cause) => error(operation, cause instanceof Error ? cause.message : String(cause)),
    });
  });

  const readConfiguration = Effect.fn("AgentContainerManager.readConfiguration")(function* (
    id: AgentContainerId,
    fallbackWorkspacePath: string,
    expectedWorkspacePath?: string,
  ) {
    const contents = yield* Effect.tryPromise({
      try: () =>
        NodeFSP.readFile(configurationPath(id), "utf8").catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            return undefined;
          }
          throw cause;
        }),
      catch: (cause) => error("configure", cause instanceof Error ? cause.message : String(cause)),
    });
    if (contents === undefined) {
      return {
        id,
        workspacePath: fallbackWorkspacePath,
        networkPolicy: "",
        imageId: DEFAULT_AGENT_CONTAINER_IMAGE_ID,
      } satisfies AgentContainerConfiguration;
    }
    const stored = yield* decodeStoredConfiguration(contents).pipe(
      Effect.mapError((cause) =>
        error("configure", `Invalid stored configuration for '${id}': ${String(cause)}`),
      ),
    );
    if (expectedWorkspacePath && stored.workspacePath !== expectedWorkspacePath) {
      return yield* error(
        "configure",
        `Container '${id}' belongs to '${stored.workspacePath}', not '${expectedWorkspacePath}'.`,
      );
    }
    return {
      id: stored.id,
      workspacePath: stored.workspacePath,
      networkPolicy: stored.networkPolicy,
      imageId: stored.imageId ?? DEFAULT_AGENT_CONTAINER_IMAGE_ID,
    } satisfies AgentContainerConfiguration;
  });

  const writeConfiguration = Effect.fn("AgentContainerManager.writeConfiguration")(function* (
    stored: typeof StoredConfiguration.Type,
  ) {
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(configurationDirectory, {
          recursive: true,
          mode: 0o700,
        });
        const destination = configurationPath(stored.id);
        const temporary = `${destination}.${process.pid}.tmp`;
        await NodeFSP.writeFile(temporary, `${encodeStoredConfiguration(stored)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await NodeFSP.rename(temporary, destination);
      },
      catch: (cause) => error("configure", cause instanceof Error ? cause.message : String(cause)),
    });
  });

  const readStoredConfigurations = Effect.fn("AgentContainerManager.readStoredConfigurations")(
    function* () {
      return yield* Effect.tryPromise({
        try: async () => {
          const entries = await NodeFSP.readdir(configurationDirectory, {
            withFileTypes: true,
          }).catch((cause: unknown) => {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
            throw cause;
          });
          return await Promise.all(
            entries
              .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
              .map(async (entry) => {
                const path = NodePath.join(configurationDirectory, entry.name);
                const [contents, metadata] = await Promise.all([
                  NodeFSP.readFile(path, "utf8"),
                  NodeFSP.stat(path),
                ]);
                const stored = decodeStoredConfigurationSync(contents);
                return {
                  ...stored,
                  createdAt: stored.createdAt ?? metadata.mtime.toISOString(),
                };
              }),
          );
        },
        catch: (cause) => error("list", cause instanceof Error ? cause.message : String(cause)),
      });
    },
  );

  const inspectManaged = Effect.fn("AgentContainerManager.inspectManaged")(function* () {
    const ids = yield* Effect.tryPromise({
      try: () =>
        podman.run(["ps", "-a", "--filter", `label=${MANAGED_LABEL}=true`, "--format", "{{.ID}}"]),
      catch: (cause) => error("list", cause instanceof Error ? cause.message : String(cause)),
    });
    if (ids.exitCode !== 0) return yield* error("list", ids.stderr);
    const containerIds = ids.stdout
      .split(/\r?\n/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (containerIds.length === 0) return [];
    const inspected = yield* Effect.tryPromise({
      try: () => podman.run(["inspect", ...containerIds]),
      catch: (cause) => error("list", cause instanceof Error ? cause.message : String(cause)),
    });
    if (inspected.exitCode !== 0) return yield* error("list", inspected.stderr);
    const decoded = yield* decodeInspectContainers(inspected.stdout).pipe(
      Effect.mapError((cause) => error("list", String(cause))),
    );
    return decoded;
  });

  const list = Effect.fn("AgentContainerManager.list")(function* () {
    const images = yield* listImages("list");
    const storedConfigurations = yield* readStoredConfigurations();
    const configuredSummary = (
      configuration: (typeof storedConfigurations)[number],
    ): AgentContainerSummary => {
      const imageId = configuration.imageId ?? DEFAULT_AGENT_CONTAINER_IMAGE_ID;
      const image = images.find((candidate) => candidate.id === imageId);
      return {
        id: configuration.id,
        name: containerName(configuration.id),
        workspacePath: configuration.workspacePath,
        imageId,
        image: image?.imageReference ?? defaultImage,
        networkPolicy: configuration.networkPolicy,
        status: "created",
        createdAt: configuration.createdAt,
      };
    };
    const publicImages = images.map(({ id, name, source }) => ({
      id,
      name,
      source,
    }));
    const version = yield* Effect.tryPromise({
      try: () => podman.run(["version", "--format", "{{.Client.Version}}"]),
      catch: (cause) => error("list", cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.result);
    if (Result.isFailure(version) || version.success.exitCode !== 0) {
      const reason = Result.isFailure(version)
        ? version.failure.message
        : version.success.stderr.trim();
      return {
        available: false,
        unavailableReason: reason || "Podman is unavailable",
        containers: storedConfigurations.map(configuredSummary),
        imagesDirectory,
        images: publicImages,
      };
    }
    const networking = yield* networkAvailability("list");
    const actualContainers = (yield* Effect.forEach(yield* inspectManaged(), (entry) => {
      const id = entry.Config.Labels[ID_LABEL];
      const workspacePath = entry.Config.Labels[WORKSPACE_LABEL];
      if (!id || !workspacePath)
        return Effect.void as Effect.Effect<AgentContainerSummary | undefined>;
      return Effect.map(
        readConfiguration(AgentContainerId.make(id), workspacePath, workspacePath),
        (configuration) => toSummary(entry, configuration),
      );
    })).flatMap((container) => (container ? [container] : []));
    const actualIds = new Set(actualContainers.map((container) => container.id));
    const containers = [
      ...actualContainers,
      ...storedConfigurations
        .filter((configuration) => !actualIds.has(configuration.id))
        .map(configuredSummary),
    ];
    return {
      available: networking.available,
      ...(networking.reason ? { unavailableReason: networking.reason } : {}),
      containers,
      imagesDirectory,
      images: publicImages,
    };
  });

  const ensureImage = Effect.fn("AgentContainerManager.ensureImage")(function* (image: string) {
    const exists = yield* Effect.tryPromise({
      try: () => podman.run(["image", "exists", image]),
      catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
    });
    if (exists.exitCode === 0) return;
    if (image !== defaultImage || defaultImage !== DEFAULT_IMAGE)
      return yield* error("create", `Configured container image '${image}' does not exist.`);
    const buildDir = NodePath.join(config.stateDir, "agent-container-image");
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(buildDir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(buildDir, "Containerfile"), CONTAINERFILE, "utf8");
      },
      catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
    });
    const built = yield* Effect.tryPromise({
      try: () =>
        podman.run([
          "build",
          "--network",
          "host",
          "--tag",
          image,
          "--file",
          NodePath.join(buildDir, "Containerfile"),
          buildDir,
        ]),
      catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
    });
    if (built.exitCode !== 0) return yield* error("create", built.stderr);
  });

  const prepareImage = Effect.fn("AgentContainerManager.prepareImage")(function* (
    image: AgentContainerImage,
    profileImage: string,
  ) {
    if (image.source === "builtin") {
      yield* ensureImage(profileImage);
      return profileImage;
    }
    if (!image.imageReference || !image.containerfilePath || !image.contextPath) {
      return yield* error("create", `Container image definition '${image.id}' is incomplete.`);
    }
    const imageReference = image.imageReference;
    const containerfilePath = image.containerfilePath;
    const contextPath = image.contextPath;
    const built = yield* Effect.tryPromise({
      try: () =>
        podman.run([
          "build",
          "--network",
          "host",
          "--tag",
          imageReference,
          "--file",
          containerfilePath,
          contextPath,
        ]),
      catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
    });
    if (built.exitCode !== 0) return yield* error("create", built.stderr);
    return imageReference;
  });

  const prepareProfileDirectories = Effect.fn("AgentContainerManager.prepareProfileDirectories")(
    function* (projectPath: string, profile: AgentContainerProfile) {
      const worktreeSource = worktreeSourceForProject(projectPath);
      yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            [worktreeSource, ...profile.resources.map((resource) => resource.source)].map((path) =>
              NodeFSP.mkdir(path, { recursive: true, mode: 0o700 }),
            ),
          ),
        catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
      });
      return worktreeSource;
    },
  );

  const resolveContainerCwd = Effect.fn("AgentContainerManager.resolveContainerCwd")(function* (
    projectPath: string,
    requestedPath: string,
  ) {
    if (requestedPath === projectPath) return "/workspace";
    const worktreeSource = worktreeSourceForProject(projectPath);
    const relative = NodePath.relative(worktreeSource, requestedPath);
    if (!relative || relative === ".." || relative.startsWith(`..${NodePath.sep}`)) {
      return yield* error(
        "create",
        `Workspace '${requestedPath}' is neither project '${projectPath}' nor one of its T3 worktrees.`,
      );
    }
    return NodePath.posix.join("/t3/worktrees", ...relative.split(NodePath.sep));
  });

  const resourceMountArguments = (
    resource: AgentContainerProfile["resources"][number],
    worktreeSource: string,
  ): ReadonlyArray<string> => {
    const relative = NodePath.relative(worktreeSource, resource.source);
    const mappedTarget =
      relative && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`)
        ? NodePath.posix.join("/t3/worktrees", ...relative.split(NodePath.sep))
        : null;
    return mappedTarget === resource.target
      ? []
      : ["--volume", `${resource.source}:${resource.target}:${resource.readOnly ? "ro" : "rw"}`];
  };

  const installNetworkPolicy = Effect.fn("AgentContainerManager.installNetworkPolicy")(function* (
    container: typeof InspectContainer.Type,
    networkPolicy: string,
  ) {
    if (container.State.Pid <= 0) {
      return yield* error("network", `Container '${container.Name}' is not running.`);
    }
    const nameservers = yield* Effect.tryPromise({
      try: async () => {
        const resolv = await NodeFSP.readFile(container.ResolvConfPath, "utf8");
        return resolv
          .split(/\r?\n/)
          .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
          .filter((value): value is string => Boolean(value));
      },
      catch: (cause) => error("network", cause instanceof Error ? cause.message : String(cause)),
    });
    const script = yield* Effect.try({
      try: () =>
        renderNftables(
          expandDnsRules(
            parseNetworkPolicy(networkPolicy, `${container.Name} network policy`),
            nameservers,
            `${container.Name} network policy`,
          ),
        ),
      catch: (cause) => error("network", cause instanceof Error ? cause.message : String(cause)),
    });
    const installed = yield* Effect.tryPromise({
      try: () =>
        podman.run(
          [
            "unshare",
            "nsenter",
            "--target",
            String(container.State.Pid),
            "--net",
            "nft",
            "--file",
            "-",
          ],
          { input: script },
        ),
      catch: (cause) => error("network", cause instanceof Error ? cause.message : String(cause)),
    });
    if (installed.exitCode !== 0) return yield* error("network", installed.stderr);
  });

  const configure = Effect.fn("AgentContainerManager.configure")(function* (
    input: AgentContainerConfigureInput,
  ) {
    const workspacePath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.workspacePath),
      catch: (cause) => error("configure", cause instanceof Error ? cause.message : String(cause)),
    });
    yield* resolveProfile(workspacePath, "configure");
    const currentConfiguration = yield* readConfiguration(input.id, workspacePath, workspacePath);
    const imageId =
      input.imageId ?? currentConfiguration.imageId ?? DEFAULT_AGENT_CONTAINER_IMAGE_ID;
    const policy = yield* Effect.try({
      try: () => parseNetworkPolicy(input.networkPolicy),
      catch: (cause) => error("configure", cause instanceof Error ? cause.message : String(cause)),
    });
    const existing = (yield* inspectManaged()).find(
      (entry) => entry.Config.Labels[ID_LABEL] === input.id,
    );
    if (!existing && !(yield* listImages("configure")).some((image) => image.id === imageId)) {
      return yield* error(
        "configure",
        `Container image definition '${imageId}' was not found in '${imagesDirectory}'.`,
      );
    }
    if (existing) {
      const existingWorkspace = existing.Config.Labels[WORKSPACE_LABEL];
      if (existingWorkspace !== workspacePath) {
        return yield* error(
          "configure",
          `Container '${input.id}' belongs to '${existingWorkspace}', not '${workspacePath}'.`,
        );
      }
      if (imageId !== currentConfiguration.imageId) {
        return yield* error(
          "configure",
          "A created container's image cannot be changed. Create a new container instead.",
        );
      }
      if (policy.rules.length > 0 && existing.HostConfig.NetworkMode === "none") {
        return yield* error(
          "configure",
          "This container predates configurable networking. Create a new container to enable outbound access.",
        );
      }
      if (existing.State.Status === "running") yield* installNetworkPolicy(existing, policy.text);
    }
    const stored = {
      version: CONFIG_VERSION,
      id: input.id,
      workspacePath,
      networkPolicy: policy.text,
      imageId,
      createdAt: new Date().toISOString(),
    } satisfies typeof StoredConfiguration.Type;
    yield* writeConfiguration(stored);
    return {
      id: stored.id,
      workspacePath: stored.workspacePath,
      networkPolicy: stored.networkPolicy,
      imageId: stored.imageId,
    } satisfies AgentContainerConfiguration;
  });

  const executionEnvironment = Effect.fn("AgentContainerManager.executionEnvironment")(
    function* (input: { readonly id: AgentContainerId; readonly workspacePath: string }) {
      const requestedWorkspacePath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.workspacePath),
        catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
      });
      const existing = (yield* inspectManaged()).find(
        (entry) => entry.Config.Labels[ID_LABEL] === input.id,
      );
      const configuration = yield* readConfiguration(
        input.id,
        existing?.Config.Labels[WORKSPACE_LABEL] ?? requestedWorkspacePath,
      );
      const projectPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(configuration.workspacePath),
        catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
      });
      const profile = yield* resolveProfile(projectPath, "create");
      const worktreeSource = yield* prepareProfileDirectories(projectPath, profile);
      const containerCwd = yield* resolveContainerCwd(projectPath, requestedWorkspacePath);
      let name: string;
      let runningContainer: typeof InspectContainer.Type;
      let environment: Readonly<Record<string, string>> = profile.environment;
      if (existing) {
        const existingWorkspace = existing.Config.Labels[WORKSPACE_LABEL];
        if (existingWorkspace !== projectPath) {
          return yield* error(
            "create",
            `Container '${input.id}' belongs to '${existingWorkspace}', not '${projectPath}'.`,
          );
        }
        const existingProfile = existing.Config.Labels[PROFILE_LABEL];
        if (existingProfile && existingProfile !== profile.fingerprint) {
          return yield* error(
            "create",
            "This container's development resources changed. Create a new container to apply the new image or mounts.",
          );
        }
        if (!existingProfile) {
          if (containerCwd !== "/workspace") {
            return yield* error(
              "create",
              "This container predates worktree mounts. Create a new container for worktree access.",
            );
          }
          environment = {};
        }
        name = existing.Name.replace(/^\//, "");
        if (existing.State.Status !== "running") {
          const started = yield* Effect.tryPromise({
            try: () => podman.run(["start", name]),
            catch: (cause) =>
              error("start", cause instanceof Error ? cause.message : String(cause)),
          });
          if (started.exitCode !== 0) return yield* error("start", started.stderr);
          const refreshed = (yield* inspectManaged()).find(
            (entry) => entry.Config.Labels[ID_LABEL] === input.id,
          );
          if (!refreshed) return yield* error("start", `Container '${input.id}' disappeared.`);
          runningContainer = refreshed;
        } else {
          runningContainer = existing;
        }
      } else {
        const networking = yield* networkAvailability("create");
        if (!networking.available) {
          return yield* error("create", networking.reason ?? "Podman networking is unavailable.");
        }
        const selectedImage = (yield* listImages("create")).find(
          (image) => image.id === configuration.imageId,
        );
        if (!selectedImage) {
          return yield* error(
            "create",
            `Container image definition '${configuration.imageId}' was not found in '${imagesDirectory}'.`,
          );
        }
        const image = yield* prepareImage(selectedImage, profile.image);
        name = containerName(input.id);
        const createArgs = [
          "create",
          "--name",
          name,
          "--label",
          `${MANAGED_LABEL}=true`,
          "--label",
          `${ID_LABEL}=${input.id}`,
          "--label",
          `${WORKSPACE_LABEL}=${projectPath}`,
          "--label",
          `${PROFILE_LABEL}=${profile.fingerprint}`,
          "--network",
          "pasta:--no-map-gw",
          "--volume",
          `${projectPath}:/workspace:rw`,
          "--volume",
          `${worktreeSource}:/t3/worktrees:rw`,
          ...profile.resources.flatMap((resource) =>
            resourceMountArguments(resource, worktreeSource),
          ),
          ...Object.entries(profile.environment).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
          "--workdir",
          "/workspace",
          image,
        ];
        const created = yield* Effect.tryPromise({
          try: () => podman.run(createArgs),
          catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
        });
        if (created.exitCode !== 0) return yield* error("create", created.stderr);
        const started = yield* Effect.tryPromise({
          try: () => podman.run(["start", name]),
          catch: (cause) => error("start", cause instanceof Error ? cause.message : String(cause)),
        });
        if (started.exitCode !== 0) return yield* error("start", started.stderr);
        const refreshed = (yield* inspectManaged()).find(
          (entry) => entry.Config.Labels[ID_LABEL] === input.id,
        );
        if (!refreshed) return yield* error("start", `Container '${input.id}' disappeared.`);
        runningContainer = refreshed;
      }
      yield* installNetworkPolicy(runningContainer, configuration.networkPolicy);
      const probe = yield* Effect.tryPromise({
        try: () => podman.run(["exec", "--workdir", containerCwd, name, "python3", "--version"]),
        catch: (cause) => error("exec", cause instanceof Error ? cause.message : String(cause)),
      });
      if (probe.exitCode !== 0) return yield* error("exec", probe.stderr);
      return new PodmanExecutionEnv(name, podman, environment, containerCwd);
    },
  );

  return AgentContainerManager.of({ list, configure, executionEnvironment });
}

export const layer = Layer.effect(
  AgentContainerManager,
  Effect.map(ServerConfig, makeAgentContainerManager),
);
