import { createAgentContainerEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-containers";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentContainerEnvironment =
  createAgentContainerEnvironmentAtoms(connectionAtomRuntime);
