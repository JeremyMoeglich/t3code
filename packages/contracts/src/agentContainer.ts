import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentContainerId = TrimmedNonEmptyString.pipe(Schema.brand("AgentContainerId"));
export type AgentContainerId = typeof AgentContainerId.Type;

export const ThreadExecutionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("host") }),
  Schema.Struct({
    kind: Schema.Literal("container"),
    containerId: AgentContainerId,
  }),
]);
export type ThreadExecutionTarget = typeof ThreadExecutionTarget.Type;

export const AgentContainerStatus = Schema.Literals(["created", "running", "stopped", "error"]);
export type AgentContainerStatus = typeof AgentContainerStatus.Type;

export const AgentContainerSummary = Schema.Struct({
  id: AgentContainerId,
  name: TrimmedNonEmptyString,
  workspacePath: TrimmedNonEmptyString,
  image: TrimmedNonEmptyString,
  networkPolicy: Schema.String,
  status: AgentContainerStatus,
  createdAt: IsoDateTime,
});
export type AgentContainerSummary = typeof AgentContainerSummary.Type;

export const AgentContainerListResult = Schema.Struct({
  available: Schema.Boolean,
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  containers: Schema.Array(AgentContainerSummary),
});
export type AgentContainerListResult = typeof AgentContainerListResult.Type;

export const AgentContainerConfigureInput = Schema.Struct({
  id: AgentContainerId,
  workspacePath: TrimmedNonEmptyString,
  networkPolicy: Schema.String,
});
export type AgentContainerConfigureInput = typeof AgentContainerConfigureInput.Type;

export const AgentContainerConfiguration = Schema.Struct({
  id: AgentContainerId,
  workspacePath: TrimmedNonEmptyString,
  networkPolicy: Schema.String,
});
export type AgentContainerConfiguration = typeof AgentContainerConfiguration.Type;

export class AgentContainerError extends Schema.TaggedErrorClass<AgentContainerError>()(
  "AgentContainerError",
  {
    operation: Schema.Literals(["list", "configure", "create", "start", "network", "exec"]),
    message: TrimmedNonEmptyString,
  },
) {}
