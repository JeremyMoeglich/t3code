import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AgentContainerImageId, type EnvironmentId } from "@t3tools/contracts";
import { FolderOpenIcon, PackageIcon } from "lucide-react";
import { memo, useEffect, useMemo } from "react";

import { agentContainerEnvironment } from "../state/agentContainers";
import { useEnvironmentQuery } from "../state/query";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const OPEN_FOLDER_VALUE = "__open-folder__";

interface BranchToolbarContainerImageSelectorProps {
  environmentId: EnvironmentId;
  value: AgentContainerImageId | null;
  locked: boolean;
  onChange: (value: AgentContainerImageId | null) => void;
}

export const BranchToolbarContainerImageSelector = memo(
  function BranchToolbarContainerImageSelector({
    environmentId,
    value,
    locked,
    onChange,
  }: BranchToolbarContainerImageSelectorProps) {
    const queryAtom = useMemo(
      () => agentContainerEnvironment.list({ environmentId, input: {} }),
      [environmentId],
    );
    const query = useEnvironmentQuery(queryAtom);
    const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
      reportFailure: false,
    });
    const images = query.data?.images ?? [];
    const selectedImage = images.find((image) => image.id === value);
    const items = [
      ...images.map((image) => ({ value: image.id, label: image.name })),
      { value: OPEN_FOLDER_VALUE, label: "Open image folders" },
    ];
    useEffect(() => {
      if (query.data && value && !selectedImage && !locked) onChange(null);
    }, [locked, onChange, query.data, selectedImage, value]);

    return (
      <Select
        modal={false}
        value={selectedImage?.id ?? null}
        items={items}
        onValueChange={(next) => {
          if (!next) return;
          if (next === OPEN_FOLDER_VALUE) {
            const cwd = query.data?.imagesDirectory;
            if (!cwd) return;
            void openInEditor({
              environmentId,
              input: { cwd, editor: "file-manager" },
            }).then((result) => {
              if (result._tag === "Failure") {
                toastManager.add({
                  type: "error",
                  title: "Could not open image folder",
                  description: String(squashAtomCommandFailure(result)),
                });
              }
            });
            return;
          }
          if (!locked) onChange(AgentContainerImageId.make(next));
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className="min-w-0 shrink font-medium"
          aria-label="Container image"
          data-composer-context-control
        >
          <PackageIcon className="size-3" />
          <span
            data-composer-label
            className="min-w-0 max-w-[160px] group-data-[compact]/composer-context:max-w-0"
          >
            <span className="block truncate group-data-[compact]/composer-context:opacity-0">
              <SelectValue placeholder={query.data ? "Choose image" : "Loading images…"} />
            </span>
          </span>
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectGroupLabel>Container image</SelectGroupLabel>
            {images.map((image) => (
              <SelectItem key={image.id} value={image.id} disabled={locked && image.id !== value}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <PackageIcon className="size-3" />
                  <span className="truncate">{image.name}</span>
                </span>
              </SelectItem>
            ))}
            {query.data && images.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No OCI images or Containerfiles found.
              </p>
            ) : null}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value={OPEN_FOLDER_VALUE} disabled={!query.data?.imagesDirectory}>
            <span className="inline-flex items-center gap-1.5">
              <FolderOpenIcon className="size-3" /> Open image folders
            </span>
          </SelectItem>
        </SelectPopup>
      </Select>
    );
  },
);
