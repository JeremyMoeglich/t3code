// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDateInEffect:off
import {
  AgentContainerError,
  AgentContainerId,
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
import { PodmanExecutionEnv } from "./PodmanExecutionEnv.ts";
import { localPodmanBackend, type PodmanBackend } from "./PodmanBackend.ts";

const MANAGED_LABEL = "dev.t3code.agent-container";
const ID_LABEL = "dev.t3code.agent-container.id";
const WORKSPACE_LABEL = "dev.t3code.agent-container.workspace";
const DEFAULT_IMAGE = "localhost/t3code-agent-base:latest";

const CONTAINERFILE = `FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
  bash build-essential ca-certificates coreutils curl fd-find file findutils git jq less \\
  procps python3 python3-pip ripgrep tree unzip zip \\
  && rm -rf /var/lib/apt/lists/*
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
  State: Schema.Struct({ Status: Schema.String }),
});

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

function toSummary(value: typeof InspectContainer.Type): AgentContainerSummary | undefined {
  const id = value.Config.Labels[ID_LABEL];
  const workspacePath = value.Config.Labels[WORKSPACE_LABEL];
  if (!id || !workspacePath) return undefined;
  return {
    id: AgentContainerId.make(id),
    name: value.Name.replace(/^\//, ""),
    workspacePath,
    image: value.Config.Image,
    status: status(value.State.Status),
    createdAt: value.Created,
  };
}

export class AgentContainerManager extends Context.Service<
  AgentContainerManager,
  {
    readonly list: () => Effect.Effect<AgentContainerListResult, AgentContainerError>;
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
  const image = process.env.T3CODE_AGENT_CONTAINER_IMAGE?.trim() || DEFAULT_IMAGE;

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
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(InspectContainer)),
    )(inspected.stdout).pipe(Effect.mapError((cause) => error("list", String(cause))));
    return decoded;
  });

  const list = Effect.fn("AgentContainerManager.list")(function* () {
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
        containers: [],
      };
    }
    const containers = (yield* inspectManaged()).flatMap((entry) => {
      const summary = toSummary(entry);
      return summary ? [summary] : [];
    });
    return { available: true, containers };
  });

  const ensureImage = Effect.fn("AgentContainerManager.ensureImage")(function* () {
    const exists = yield* Effect.tryPromise({
      try: () => podman.run(["image", "exists", image]),
      catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
    });
    if (exists.exitCode === 0) return;
    if (image !== DEFAULT_IMAGE)
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

  const executionEnvironment = Effect.fn("AgentContainerManager.executionEnvironment")(
    function* (input: { readonly id: AgentContainerId; readonly workspacePath: string }) {
      const workspacePath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.workspacePath),
        catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
      });
      const existing = (yield* inspectManaged()).find(
        (entry) => entry.Config.Labels[ID_LABEL] === input.id,
      );
      let name: string;
      if (existing) {
        const existingWorkspace = existing.Config.Labels[WORKSPACE_LABEL];
        if (existingWorkspace !== workspacePath) {
          return yield* error(
            "create",
            `Container '${input.id}' belongs to '${existingWorkspace}', not '${workspacePath}'.`,
          );
        }
        name = existing.Name.replace(/^\//, "");
        if (existing.State.Status !== "running") {
          const started = yield* Effect.tryPromise({
            try: () => podman.run(["start", name]),
            catch: (cause) =>
              error("start", cause instanceof Error ? cause.message : String(cause)),
          });
          if (started.exitCode !== 0) return yield* error("start", started.stderr);
        }
      } else {
        yield* ensureImage();
        name = `t3-agent-${String(input.id)
          .replace(/[^a-zA-Z0-9_.-]/g, "-")
          .slice(0, 48)}`;
        const created = yield* Effect.tryPromise({
          try: () =>
            podman.run([
              "create",
              "--name",
              name,
              "--label",
              `${MANAGED_LABEL}=true`,
              "--label",
              `${ID_LABEL}=${input.id}`,
              "--label",
              `${WORKSPACE_LABEL}=${workspacePath}`,
              "--network",
              "none",
              "--volume",
              `${workspacePath}:/workspace:rw`,
              "--workdir",
              "/workspace",
              image,
            ]),
          catch: (cause) => error("create", cause instanceof Error ? cause.message : String(cause)),
        });
        if (created.exitCode !== 0) return yield* error("create", created.stderr);
        const started = yield* Effect.tryPromise({
          try: () => podman.run(["start", name]),
          catch: (cause) => error("start", cause instanceof Error ? cause.message : String(cause)),
        });
        if (started.exitCode !== 0) return yield* error("start", started.stderr);
      }
      const probe = yield* Effect.tryPromise({
        try: () => podman.run(["exec", "--workdir", "/workspace", name, "python3", "--version"]),
        catch: (cause) => error("exec", cause instanceof Error ? cause.message : String(cause)),
      });
      if (probe.exitCode !== 0) return yield* error("exec", probe.stderr);
      return new PodmanExecutionEnv(name, podman);
    },
  );

  return AgentContainerManager.of({ list, executionEnvironment });
}

export const layer = Layer.effect(
  AgentContainerManager,
  Effect.map(ServerConfig, makeAgentContainerManager),
);
