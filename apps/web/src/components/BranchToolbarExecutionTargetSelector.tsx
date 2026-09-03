import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AgentContainerImageId,
  AgentContainerSummary,
  EnvironmentId,
  ThreadExecutionTarget,
} from "@t3tools/contracts";
import { AgentContainerId, DEFAULT_AGENT_CONTAINER_IMAGE_ID } from "@t3tools/contracts";
import { BoxIcon, MonitorIcon, PlusIcon, ShieldIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { agentContainerEnvironment } from "../state/agentContainers";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { randomUUID } from "../lib/utils";
import { AgentContainerNetworkDialog } from "./AgentContainerNetworkDialog";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarExecutionTargetSelectorProps {
  environmentId: EnvironmentId;
  workspacePath: string | null;
  value: ThreadExecutionTarget;
  locked: boolean;
  onChange: (value: ThreadExecutionTarget) => void;
}

const HOST_VALUE = "host";
const NEW_VALUE = "new";
const NETWORK_VALUE = "network";
const containerValue = (id: AgentContainerId) => `container:${id}`;

type NetworkDialog =
  | { readonly kind: "create"; readonly id: AgentContainerId }
  | { readonly kind: "edit"; readonly container: AgentContainerSummary };

export const BranchToolbarExecutionTargetSelector = memo(
  function BranchToolbarExecutionTargetSelector({
    environmentId,
    workspacePath,
    value,
    locked,
    onChange,
  }: BranchToolbarExecutionTargetSelectorProps) {
    const [networkDialog, setNetworkDialog] = useState<NetworkDialog | null>(null);
    const configure = useAtomCommand(agentContainerEnvironment.configure, {
      reportFailure: false,
    });
    const queryAtom = useMemo(
      () => agentContainerEnvironment.list({ environmentId, input: {} }),
      [environmentId],
    );
    const query = useEnvironmentQuery(queryAtom);
    const images = query.data?.images ?? [
      {
        id: DEFAULT_AGENT_CONTAINER_IMAGE_ID,
        name: "T3 default",
        source: "builtin" as const,
      },
    ];
    const compatible = useMemo(
      () =>
        workspacePath
          ? (query.data?.containers.filter(
              (container) => container.workspacePath === workspacePath,
            ) ?? [])
          : [],
      [query.data?.containers, workspacePath],
    );
    const selectedContainer =
      value.kind === "container"
        ? (compatible.find((container) => container.id === value.containerId) ?? null)
        : null;
    const selectedValue = value.kind === "host" ? HOST_VALUE : containerValue(value.containerId);
    const pendingContainer =
      value.kind === "container" && selectedContainer === null
        ? {
            value: containerValue(value.containerId),
            label: `Container ${value.containerId.slice(0, 8)}`,
          }
        : null;
    const podmanAvailable = query.data?.available !== false;
    const items = [
      { value: HOST_VALUE, label: "Host" },
      { value: NEW_VALUE, label: "New container" },
      ...(selectedContainer ? [{ value: NETWORK_VALUE, label: "Network policy" }] : []),
      ...compatible.map((container) => ({
        value: containerValue(container.id),
        label: container.name,
      })),
      ...(pendingContainer ? [pendingContainer] : []),
    ];

    return (
      <>
        <Select
          modal={false}
          value={selectedValue}
          items={items}
          onValueChange={(next: string | null) => {
            if (next === NETWORK_VALUE) {
              if (selectedContainer)
                setNetworkDialog({
                  kind: "edit",
                  container: selectedContainer,
                });
              return;
            }
            if (locked) return;
            if (!next || next === HOST_VALUE) {
              onChange({ kind: "host" });
              return;
            }
            if (next === NEW_VALUE) {
              if (workspacePath) {
                setNetworkDialog({
                  kind: "create",
                  id: AgentContainerId.make(randomUUID()),
                });
              }
              return;
            }
            onChange({
              kind: "container",
              containerId: AgentContainerId.make(next.slice("container:".length)),
            });
          }}
        >
          <SelectTrigger
            variant="ghost"
            size="xs"
            className="min-w-0 shrink font-medium"
            aria-label="Execution environment"
            data-composer-context-control
          >
            {value.kind === "host" ? (
              <MonitorIcon className="size-3" />
            ) : (
              <BoxIcon className="size-3" />
            )}
            <span
              data-composer-label
              className="min-w-0 max-w-[200px] group-data-[compact]/composer-context:max-w-0"
            >
              <span className="block truncate group-data-[compact]/composer-context:opacity-0">
                <SelectValue />
              </span>
            </span>
          </SelectTrigger>
          <SelectPopup>
            <SelectGroup>
              <SelectGroupLabel>Agent runs in</SelectGroupLabel>
              <SelectItem value={HOST_VALUE} disabled={locked && value.kind !== "host"}>
                <span className="inline-flex items-center gap-1.5">
                  <MonitorIcon className="size-3" /> Host
                </span>
              </SelectItem>
              <SelectItem value={NEW_VALUE} disabled={locked || !workspacePath}>
                <span className="inline-flex items-center gap-1.5">
                  <PlusIcon className="size-3" /> New container
                </span>
              </SelectItem>
              {selectedContainer ? (
                <SelectItem value={NETWORK_VALUE}>
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldIcon className="size-3" /> Network policy…
                  </span>
                </SelectItem>
              ) : null}
              {compatible.map((container) => (
                <SelectItem
                  key={container.id}
                  value={containerValue(container.id)}
                  disabled={locked && container.id !== selectedContainer?.id}
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <BoxIcon className="size-3" />
                    <span className="truncate">{container.name}</span>
                  </span>
                </SelectItem>
              ))}
              {pendingContainer ? (
                <SelectItem value={pendingContainer.value}>
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <BoxIcon className="size-3" />
                    <span className="truncate">{pendingContainer.label}</span>
                  </span>
                </SelectItem>
              ) : null}
            </SelectGroup>
            {!podmanAvailable && query.data?.unavailableReason ? (
              <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                {query.data.unavailableReason}
              </p>
            ) : null}
          </SelectPopup>
        </Select>
        <AgentContainerNetworkDialog
          open={networkDialog !== null}
          creating={networkDialog?.kind === "create"}
          initialPolicy={
            networkDialog?.kind === "edit" ? networkDialog.container.networkPolicy : ""
          }
          images={images}
          {...(networkDialog?.kind === "edit" && networkDialog.container.imageId
            ? { initialImageId: networkDialog.container.imageId }
            : {})}
          {...(query.data?.imagesDirectory ? { imagesDirectory: query.data.imagesDirectory } : {})}
          onOpenChange={(open) => !open && setNetworkDialog(null)}
          onSave={async (networkPolicy, imageId: AgentContainerImageId) => {
            if (!networkDialog || !workspacePath) return "A workspace is required.";
            const id =
              networkDialog.kind === "create" ? networkDialog.id : networkDialog.container.id;
            const result = await configure({
              environmentId,
              input: { id, workspacePath, networkPolicy, imageId },
            });
            if (result._tag === "Failure") {
              const cause = squashAtomCommandFailure(result);
              return cause instanceof Error ? cause.message : String(cause);
            }
            query.refresh();
            if (networkDialog.kind === "create") {
              onChange({ kind: "container", containerId: id });
            }
            return null;
          }}
        />
      </>
    );
  },
);
