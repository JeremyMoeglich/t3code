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

it.effect("creates a T3-owned, network-isolated workspace container", () =>
  Effect.gen(function* () {
    const workspacePath = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-container-manager-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(workspacePath, { recursive: true, force: true })),
    );
    const calls: ReadonlyArray<string>[] = [];
    const podman: PodmanBackend = {
      spawn: () => {
        throw new Error("Tool execution is outside this lifecycle test.");
      },
      run: (args) => {
        calls.push(args);
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    };
    const manager = makeAgentContainerManager(
      { stateDir: NodePath.join(workspacePath, "state") } as ServerConfig["Service"],
      podman,
    );

    yield* manager.executionEnvironment({
      id: AgentContainerId.make("container-1"),
      workspacePath,
    });

    const create = calls.find((args) => args[0] === "create");
    assert.isDefined(create);
    assert.include(create, "none");
    assert.include(create, `${workspacePath}:/workspace:rw`);
    assert.include(create, "dev.t3code.agent-container=true");
    assert.include(create, "dev.t3code.agent-container.id=container-1");
  }),
);
