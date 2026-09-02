import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAgentContainerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-containers:list",
      tag: WS_METHODS.agentContainersList,
      refreshIntervalMs: 5_000,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-containers:configure",
      tag: WS_METHODS.agentContainersConfigure,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => `${environmentId}:${input.id}`,
      },
    }),
  };
}
