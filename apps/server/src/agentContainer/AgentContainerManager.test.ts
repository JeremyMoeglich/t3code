// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { AgentContainerId, AgentContainerImageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerConfig } from "../config.ts";
import { makeAgentContainerManager } from "./AgentContainerManager.ts";
import type { PodmanBackend } from "./PodmanBackend.ts";

it.effect("creates a T3-owned container and installs its outbound policy", () =>
  Effect.gen(function* () {
    const workspacePath = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-container-manager-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(workspacePath, { recursive: true, force: true })),
    );
    const resolvConfPath = NodePath.join(workspacePath, "resolv.conf");
    const baseDir = NodePath.join(workspacePath, "t3-home");
    const imageContext = NodePath.join(baseDir, "container-images", "containerfiles", "typescript");
    yield* Effect.promise(() => NodeFSP.mkdir(imageContext, { recursive: true }));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(imageContext, "Containerfile"), "FROM node:24\n"),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(resolvConfPath, "nameserver 10.0.2.3\n"));
    const calls: Array<{
      readonly args: ReadonlyArray<string>;
      readonly input?: string | Uint8Array;
    }> = [];
    let created = false;
    let running = false;
    let imageCached = false;
    let networkAvailabilityCalls = 0;
    let currentContainerId = "container-1";
    let currentContainerName = "t3-agent-container-1";
    let currentNetworkMode = "pasta";
    let profileLabel: string | undefined;
    const inspect = () =>
      JSON.stringify([
        {
          Id: "podman-id",
          Name: currentContainerName,
          Created: "2026-09-02T00:00:00.000Z",
          Config: {
            Image: "localhost/t3code-agent-base:3",
            Labels: {
              "dev.t3code.agent-container": "true",
              "dev.t3code.agent-container.id": currentContainerId,
              "dev.t3code.agent-container.workspace": workspacePath,
              ...(profileLabel ? { "dev.t3code.agent-container.profile": profileLabel } : {}),
            },
          },
          HostConfig: { NetworkMode: currentNetworkMode },
          ResolvConfPath: resolvConfPath,
          State: {
            Status: running ? "running" : "created",
            Pid: running ? 1234 : 0,
          },
        },
      ]);
    const podman: PodmanBackend = {
      networkAvailability: () => {
        networkAvailabilityCalls += 1;
        return Promise.resolve({ available: true });
      },
      spawn: () => {
        throw new Error("Tool execution is outside this lifecycle test.");
      },
      run: async (args, options) => {
        calls.push({
          args,
          ...(options?.input === undefined ? {} : { input: options.input }),
        });
        if (args[0] === "ps") {
          return {
            stdout: created ? "podman-id\n" : "",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "inspect") {
          return {
            stdout: inspect(),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "image" && args[1] === "exists") {
          return { stdout: "", stderr: "", exitCode: imageCached ? 0 : 1 };
        }
        if (args[0] === "pull") {
          return { stdout: "sha256:imported\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "save") {
          const output = args[args.indexOf("--output") + 1];
          assert.isDefined(output);
          await NodeFSP.writeFile(output, "oci archive");
        }
        if (args[0] === "tag") imageCached = true;
        if (args[0] === "create") {
          created = true;
          currentNetworkMode = args[args.indexOf("--network") + 1]?.split(":")[0] ?? "none";
          currentContainerName = args[args.indexOf("--name") + 1] ?? currentContainerName;
          currentContainerId =
            args
              .find((value) => value.startsWith("dev.t3code.agent-container.id="))
              ?.slice("dev.t3code.agent-container.id=".length) ?? currentContainerId;
          profileLabel = args
            .find((value) => value.startsWith("dev.t3code.agent-container.profile="))
            ?.slice("dev.t3code.agent-container.profile=".length);
        }
        if (args[0] === "start") running = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const manager = makeAgentContainerManager(
      {
        baseDir,
        stateDir: NodePath.join(workspacePath, "state"),
        worktreesDir: NodePath.join(workspacePath, "worktrees"),
      } as ServerConfig["Service"],
      podman,
    );
    const id = AgentContainerId.make("container-1");

    yield* manager.configure({
      id,
      workspacePath,
      networkMode: "custom",
      networkPolicy: "allow 0.0.0.0/0\ndeny 10.0.0.0/8\nallow dns udp 53",
      imageId: AgentContainerImageId.make("folder:typescript"),
    });
    const projectEnvironment = yield* manager.executionEnvironment({
      id,
      workspacePath,
    });

    const create = calls.find(({ args }) => args[0] === "create")?.args;
    const build = calls.find(({ args }) => args[0] === "build")?.args;
    const save = calls.find(({ args }) => args[0] === "save")?.args;
    const tag = calls.find(({ args }) => args[0] === "tag")?.args;
    assert.isDefined(create);
    assert.isDefined(build);
    assert.isDefined(save);
    assert.isDefined(tag);
    assert.include(build, NodePath.join(imageContext, "Containerfile"));
    assert.equal(build.at(-1), imageContext);
    assert.equal(save.at(-1), build[build.indexOf("--tag") + 1]);
    assert.equal(save[save.indexOf("--format") + 1], "oci-archive");
    assert.equal(tag[1], build[build.indexOf("--tag") + 1]);
    assert.equal(create.at(-1), tag[2]);
    const promoted = yield* Effect.promise(() =>
      NodeFSP.stat(NodePath.join(baseDir, "container-images", "oci", "typescript.tar")),
    );
    assert.isTrue(promoted.isFile());
    assert.include(create, "pasta:--no-map-gw");
    assert.include(create, `${workspacePath}:/workspace:rw`);
    assert.include(
      create,
      `${NodePath.join(
        workspacePath,
        "worktrees",
        NodePath.basename(workspacePath),
      )}:/t3/worktrees:rw`,
    );
    assert.notInclude(
      create,
      `${NodePath.join(
        workspacePath,
        "worktrees",
        NodePath.basename(workspacePath),
        ".t3-container-resources",
        "package-cache",
      )}:/t3/worktrees/.t3-container-resources/package-cache:rw`,
    );
    assert.isTrue(create?.some((value) => value.endsWith(":/t3/tools:rw")));
    assert.include(
      create,
      "pnpm_config_store_dir=/t3/worktrees/.t3-container-resources/package-cache/pnpm",
    );
    assert.include(create, "dev.t3code.agent-container=true");
    assert.equal(projectEnvironment.cwd, "/workspace");
    const policy = calls.find(({ args }) => args.includes("nft"));
    assert.isDefined(policy);
    assert.isTrue(typeof policy.input === "string");
    assert.include(String(policy.input), "ip daddr 10.0.0.0/8 drop");
    assert.include(String(policy.input), "ip daddr 10.0.2.3/32 udp dport 53");

    const worktreePath = NodePath.join(
      workspacePath,
      "worktrees",
      NodePath.basename(workspacePath),
      "t3code-feature",
    );
    yield* Effect.promise(() => NodeFSP.mkdir(worktreePath, { recursive: true }));
    const worktreeEnvironment = yield* manager.executionEnvironment({
      id,
      workspacePath: worktreePath,
    });
    assert.equal(worktreeEnvironment.cwd, "/t3/worktrees/t3code-feature");

    calls.length = 0;
    created = false;
    running = false;
    imageCached = false;
    const importedId = AgentContainerId.make("container-2");
    yield* manager.configure({
      id: importedId,
      workspacePath,
      networkMode: "offline",
      networkPolicy: "",
      imageId: AgentContainerImageId.make("folder:typescript"),
    });
    yield* manager.executionEnvironment({ id: importedId, workspacePath });

    const exists = calls.find(({ args }) => args[0] === "image" && args[1] === "exists")?.args;
    const pull = calls.find(({ args }) => args[0] === "pull")?.args;
    const importedTag = calls.find(
      ({ args }) => args[0] === "tag" && args[1] === "sha256:imported",
    )?.args;
    const importedCreate = calls.find(({ args }) => args[0] === "create")?.args;
    assert.isDefined(exists);
    assert.isDefined(pull);
    assert.equal(
      pull[2],
      `oci-archive:${NodePath.join(baseDir, "container-images", "oci", "typescript.tar")}`,
    );
    assert.isDefined(importedTag);
    assert.equal(importedCreate?.at(-1), importedTag[2]);
    assert.isTrue(importedCreate?.includes("none"));
    assert.isFalse(calls.some(({ args }) => args[0] === "build"));
    assert.isFalse(calls.some(({ args }) => args.includes("nft")));
    assert.equal(networkAvailabilityCalls, 1);

    calls.length = 0;
    created = false;
    running = false;
    imageCached = true;
    const hostId = AgentContainerId.make("container-host");
    yield* manager.configure({
      id: hostId,
      workspacePath,
      networkMode: "host",
      networkPolicy: "allow 10.0.0.0/8",
      imageId: AgentContainerImageId.make("folder:typescript"),
    });
    const hostEnvironment = yield* manager.executionEnvironment({
      id: hostId,
      workspacePath,
    });
    const hostCreate = calls.find(({ args }) => args[0] === "create")?.args;
    assert.isTrue(hostCreate?.includes("host"));
    assert.equal(hostEnvironment.cwd, "/workspace");
    assert.isFalse(calls.some(({ args }) => args.includes("nft")));
    assert.equal(networkAvailabilityCalls, 1);
  }),
);

it.effect("configures containers and lists image folders while networking is unavailable", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-container-catalog-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const workspacePath = NodePath.join(root, "workspace");
    const imageContext = NodePath.join(root, "container-images", "containerfiles", "web");
    const ociDirectory = NodePath.join(root, "container-images", "oci");
    yield* Effect.promise(() => NodeFSP.mkdir(workspacePath, { recursive: true }));
    yield* Effect.promise(() => NodeFSP.mkdir(imageContext, { recursive: true }));
    yield* Effect.promise(() => NodeFSP.mkdir(ociDirectory, { recursive: true }));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(imageContext, "Containerfile"), "FROM node:24\n"),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(ociDirectory, "web.tar"), "oci"));
    const podman: PodmanBackend = {
      networkAvailability: () =>
        Promise.resolve({
          available: false,
          reason: "TUN device unavailable",
        }),
      spawn: () => {
        throw new Error("Tool execution is outside this configuration test.");
      },
      run: (args) => {
        if (args[0] === "version") {
          return Promise.resolve({
            stdout: "5.6.0\n",
            stderr: "",
            exitCode: 0,
          });
        }
        if (args[0] === "ps") {
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    };
    const manager = makeAgentContainerManager(
      {
        baseDir: root,
        stateDir: NodePath.join(root, "state"),
        worktreesDir: NodePath.join(root, "worktrees"),
      } as ServerConfig["Service"],
      podman,
    );
    const id = AgentContainerId.make("configured-offline");

    const configuration = yield* manager.configure({
      id,
      workspacePath,
      networkMode: "offline",
      networkPolicy: "",
      imageId: AgentContainerImageId.make("folder:web"),
    });
    const legacyId = AgentContainerId.make("legacy-internet");
    const configurationDirectory = NodePath.join(root, "state", "agent-containers");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(
          configurationDirectory,
          `${Buffer.from(String(legacyId)).toString("base64url")}.json`,
        ),
        `{"version":1,"id":"${legacyId}","workspacePath":"${workspacePath}","networkPolicy":"allow 0.0.0.0/0\\nallow ::/0","imageId":"folder:web"}\n`,
      ),
    );
    const listed = yield* manager.list();

    assert.equal(configuration.imageId, "folder:web");
    assert.equal(configuration.networkMode, "offline");
    assert.isTrue(listed.available);
    assert.isFalse(listed.isolatedNetworkingAvailable);
    assert.equal(listed.isolatedNetworkingUnavailableReason, "TUN device unavailable");
    assert.equal(listed.imagesDirectory, NodePath.join(root, "container-images"));
    assert.deepEqual(
      listed.images.map((image) => image.id),
      ["folder:web"],
    );
    assert.equal(listed.images[0]?.source, "oci");
    const offline = listed.containers.find((container) => container.id === id);
    assert.equal(offline?.imageId, "folder:web");
    assert.equal(offline?.networkMode, "offline");
    assert.equal(offline?.status, "created");
    const legacy = listed.containers.find((container) => container.id === legacyId);
    assert.equal(legacy?.networkMode, "internet");
  }),
);
