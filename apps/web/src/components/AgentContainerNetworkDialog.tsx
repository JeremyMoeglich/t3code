import {
  AGENT_CONTAINER_INTERNET_POLICY,
  type AgentContainerNetworkMode,
} from "@t3tools/contracts";
import { BoxIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Radio, RadioGroup } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";

export interface AgentContainerNetworkSelection {
  networkMode: AgentContainerNetworkMode;
  networkPolicy: string;
}

interface AgentContainerNetworkDialogProps {
  open: boolean;
  initialMode: AgentContainerNetworkMode;
  initialPolicy: string;
  isolatedNetworkingAvailable: boolean;
  isolatedNetworkingUnavailableReason?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (selection: AgentContainerNetworkSelection) => Promise<string | null>;
}

export function AgentContainerNetworkDialog({
  open,
  initialMode,
  initialPolicy,
  isolatedNetworkingAvailable,
  isolatedNetworkingUnavailableReason,
  onOpenChange,
  onSave,
}: AgentContainerNetworkDialogProps) {
  const [mode, setMode] = useState<AgentContainerNetworkMode>(initialMode);
  const [customPolicy, setCustomPolicy] = useState(initialPolicy);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setCustomPolicy(initialPolicy);
    setError(null);
  }, [initialMode, initialPolicy, open]);

  const policy =
    mode === "internet" ? AGENT_CONTAINER_INTERNET_POLICY : mode === "custom" ? customPolicy : "";
  const selectedModeUnavailable =
    !isolatedNetworkingAvailable && (mode === "internet" || mode === "custom");

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BoxIcon className="size-4" />
            Container networking
          </DialogTitle>
          <DialogDescription>
            Choose whether the container is offline, shares the host network, or gets an isolated
            network namespace. Threads that select it inherit the same mode.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as AgentContainerNetworkMode)}
          >
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
              <Radio value="offline" />
              <span>
                <span className="block text-sm font-medium">Offline</span>
                <span className="block text-xs text-muted-foreground">
                  Loopback works, but no outbound destination is allowed.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
              <Radio value="host" />
              <span>
                <span className="block text-sm font-medium">Host</span>
                <span className="block text-xs text-muted-foreground">
                  Broad network access through the host namespace. Host loopback and listening ports
                  are shared.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60">
              <Radio value="internet" disabled={!isolatedNetworkingAvailable} />
              <span>
                <span className="block text-sm font-medium">Internet</span>
                <span className="block text-xs text-muted-foreground">
                  Allow all reachable IPv4 and IPv6 destinations while retaining an isolated network
                  namespace.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60">
              <Radio value="custom" disabled={!isolatedNetworkingAvailable} />
              <span>
                <span className="block text-sm font-medium">Custom IP policy</span>
                <span className="block text-xs text-muted-foreground">
                  Default deny. Put broad rules first and strictly narrower exceptions below.
                </span>
              </span>
            </label>
          </RadioGroup>

          {!isolatedNetworkingAvailable && isolatedNetworkingUnavailableReason ? (
            <p className="text-xs text-muted-foreground">
              Internet and Custom require isolated Podman networking:{" "}
              {isolatedNetworkingUnavailableReason}
            </p>
          ) : null}

          {mode === "custom" ? (
            <div className="space-y-2">
              <Textarea
                aria-label="Container network policy"
                className="min-h-40 font-mono text-xs"
                placeholder={
                  "allow 10.0.0.0/16\ndeny 10.0.8.0/24\nallow 10.0.8.5 tcp 443\nallow dns tcp,udp 53"
                }
                value={customPolicy}
                onChange={(event) => setCustomPolicy(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Format: allow|deny IP_OR_CIDR [tcp,udp,icmp [ports]]. The dns sentinel expands to
                Podman&apos;s configured nameservers.
              </p>
            </div>
          ) : null}

          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || selectedModeUnavailable}
            onClick={() => {
              setSaving(true);
              setError(null);
              void onSave({ networkMode: mode, networkPolicy: policy }).then((message) => {
                setSaving(false);
                if (message) setError(message);
                else onOpenChange(false);
              });
            }}
          >
            {saving ? "Saving…" : "Save networking"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
