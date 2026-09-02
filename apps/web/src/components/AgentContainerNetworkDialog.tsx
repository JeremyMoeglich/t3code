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

export const UNRESTRICTED_NETWORK_POLICY = "allow 0.0.0.0/0\nallow ::/0";

type NetworkPreset = "offline" | "internet" | "custom";

function presetFor(policy: string): NetworkPreset {
  if (!policy.trim()) return "offline";
  if (policy.trim() === UNRESTRICTED_NETWORK_POLICY) return "internet";
  return "custom";
}

interface AgentContainerNetworkDialogProps {
  open: boolean;
  creating: boolean;
  initialPolicy: string;
  onOpenChange: (open: boolean) => void;
  onSave: (networkPolicy: string) => Promise<string | null>;
}

export function AgentContainerNetworkDialog({
  open,
  creating,
  initialPolicy,
  onOpenChange,
  onSave,
}: AgentContainerNetworkDialogProps) {
  const [preset, setPreset] = useState<NetworkPreset>(() => presetFor(initialPolicy));
  const [customPolicy, setCustomPolicy] = useState(initialPolicy);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreset(presetFor(initialPolicy));
    setCustomPolicy(initialPolicy);
    setError(null);
  }, [initialPolicy, open]);

  const policy =
    preset === "offline" ? "" : preset === "internet" ? UNRESTRICTED_NETWORK_POLICY : customPolicy;

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BoxIcon className="size-4" />
            {creating ? "Create container" : "Container network policy"}
          </DialogTitle>
          <DialogDescription>
            Outbound access is owned by this container. Threads that select it inherit the same
            policy.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <RadioGroup value={preset} onValueChange={(value) => setPreset(value as NetworkPreset)}>
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
              <Radio value="internet" />
              <span>
                <span className="block text-sm font-medium">Internet</span>
                <span className="block text-xs text-muted-foreground">
                  Allow all reachable IPv4 and IPv6 destinations while retaining an isolated network
                  namespace.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
              <Radio value="custom" />
              <span>
                <span className="block text-sm font-medium">Custom IP policy</span>
                <span className="block text-xs text-muted-foreground">
                  Default deny. Put broad rules first and strictly narrower exceptions below.
                </span>
              </span>
            </label>
          </RadioGroup>

          {preset === "custom" ? (
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
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void onSave(policy).then((message) => {
                setSaving(false);
                if (message) setError(message);
                else onOpenChange(false);
              });
            }}
          >
            {saving ? "Saving…" : creating ? "Create" : "Save policy"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
