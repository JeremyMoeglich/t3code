import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentContainerId = TrimmedNonEmptyString.pipe(Schema.brand("AgentContainerId"));
export type AgentContainerId = typeof AgentContainerId.Type;

export const AgentContainerImageId = TrimmedNonEmptyString.pipe(
  Schema.brand("AgentContainerImageId"),
);
export type AgentContainerImageId = typeof AgentContainerImageId.Type;

export const AgentContainerImageDefinition = Schema.Struct({
  id: AgentContainerImageId,
  name: TrimmedNonEmptyString,
  source: Schema.Literals(["oci", "containerfile"]),
});
export type AgentContainerImageDefinition = typeof AgentContainerImageDefinition.Type;

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

export const AgentContainerNetworkMode = Schema.Literals(["offline", "host", "internet", "custom"]);
export type AgentContainerNetworkMode = typeof AgentContainerNetworkMode.Type;

export const AGENT_CONTAINER_INTERNET_POLICY = "allow 0.0.0.0/0\nallow ::/0";

export const AgentContainerSummary = Schema.Struct({
  id: AgentContainerId,
  name: TrimmedNonEmptyString,
  workspacePath: TrimmedNonEmptyString,
  image: TrimmedNonEmptyString,
  imageId: Schema.optional(AgentContainerImageId),
  networkMode: AgentContainerNetworkMode,
  networkPolicy: Schema.String,
  status: AgentContainerStatus,
  createdAt: IsoDateTime,
});
export type AgentContainerSummary = typeof AgentContainerSummary.Type;

export const AgentContainerListResult = Schema.Struct({
  available: Schema.Boolean,
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  isolatedNetworkingAvailable: Schema.Boolean,
  isolatedNetworkingUnavailableReason: Schema.optional(TrimmedNonEmptyString),
  containers: Schema.Array(AgentContainerSummary),
  imagesDirectory: Schema.optional(TrimmedNonEmptyString),
  images: Schema.Array(AgentContainerImageDefinition),
});
export type AgentContainerListResult = typeof AgentContainerListResult.Type;

export const AgentContainerConfigureInput = Schema.Struct({
  id: AgentContainerId,
  workspacePath: TrimmedNonEmptyString,
  networkMode: AgentContainerNetworkMode,
  networkPolicy: Schema.String,
  imageId: AgentContainerImageId,
});
export type AgentContainerConfigureInput = typeof AgentContainerConfigureInput.Type;

export const AgentContainerConfiguration = Schema.Struct({
  id: AgentContainerId,
  workspacePath: TrimmedNonEmptyString,
  networkMode: AgentContainerNetworkMode,
  networkPolicy: Schema.String,
  imageId: Schema.optional(AgentContainerImageId),
});
export type AgentContainerConfiguration = typeof AgentContainerConfiguration.Type;

export class AgentContainerError extends Schema.TaggedErrorClass<AgentContainerError>()(
  "AgentContainerError",
  {
    operation: Schema.Literals(["list", "configure", "create", "start", "network", "exec"]),
    message: TrimmedNonEmptyString,
  },
) {}
