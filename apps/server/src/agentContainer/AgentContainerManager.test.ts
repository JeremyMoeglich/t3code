// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { AgentContainerId } from "@t3tools/contracts";
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
    yield* Effect.promise(() => NodeFSP.writeFile(resolvConfPath, "nameserver 10.0.2.3\n"));
    const calls: Array<{
      readonly args: ReadonlyArray<string>;
      readonly input?: string | Uint8Array;
    }> = [];
    let created = false;
    let running = false;
    let profileLabel: string | undefined;
    const inspect = () =>
      JSON.stringify([
        {
          Id: "podman-id",
          Name: "t3-agent-container-1",
          Created: "2026-09-02T00:00:00.000Z",
          Config: {
            Image: "localhost/t3code-agent-base:3",
            Labels: {
              "dev.t3code.agent-container": "true",
              "dev.t3code.agent-container.id": "container-1",
              "dev.t3code.agent-container.workspace": workspacePath,
              ...(profileLabel ? { "dev.t3code.agent-container.profile": profileLabel } : {}),
            },
          },
          HostConfig: { NetworkMode: "pasta" },
          ResolvConfPath: resolvConfPath,
          State: {
            Status: running ? "running" : "created",
            Pid: running ? 1234 : 0,
          },
        },
      ]);
    const podman: PodmanBackend = {
      networkAvailability: () => Promise.resolve({ available: true }),
      spawn: () => {
        throw new Error("Tool execution is outside this lifecycle test.");
      },
      run: (args, options) => {
        calls.push({
          args,
          ...(options?.input === undefined ? {} : { input: options.input }),
        });
        if (args[0] === "ps") {
          return Promise.resolve({
            stdout: created ? "podman-id\n" : "",
            stderr: "",
            exitCode: 0,
          });
        }
        if (args[0] === "inspect") {
          return Promise.resolve({
            stdout: inspect(),
            stderr: "",
            exitCode: 0,
          });
        }
        if (args[0] === "create") {
          created = true;
          profileLabel = args
            .find((value) => value.startsWith("dev.t3code.agent-container.profile="))
            ?.slice("dev.t3code.agent-container.profile=".length);
        }
        if (args[0] === "start") running = true;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    };
    const manager = makeAgentContainerManager(
      {
        stateDir: NodePath.join(workspacePath, "state"),
        worktreesDir: NodePath.join(workspacePath, "worktrees"),
      } as ServerConfig["Service"],
      podman,
    );
    const id = AgentContainerId.make("container-1");

    yield* manager.configure({
      id,
      workspacePath,
      networkPolicy: "allow 0.0.0.0/0\ndeny 10.0.0.0/8\nallow dns udp 53",
    });
    const projectEnvironment = yield* manager.executionEnvironment({ id, workspacePath });

    const create = calls.find(({ args }) => args[0] === "create")?.args;
    assert.isDefined(create);
    assert.include(create, "pasta:--no-map-gw");
    assert.include(create, `${workspacePath}:/workspace:rw`);
    assert.include(
      create,
      `${NodePath.join(workspacePath, "worktrees", NodePath.basename(workspacePath))}:/t3/worktrees:rw`,
    );
    assert.notInclude(
      create,
      `${NodePath.join(workspacePath, "worktrees", NodePath.basename(workspacePath), ".t3-container-resources", "package-cache")}:/t3/worktrees/.t3-container-resources/package-cache:rw`,
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
  }),
);
