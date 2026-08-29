// @effect-diagnostics globalDateInEffect:off
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  T3AgentSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { makeT3AgentAdapter } from "../Layers/T3AgentAdapter.ts";
import { makePiCredentialStore } from "../PiCredentialStore.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("t3Agent");
const decodeSettings = Schema.decodeSync(T3AgentSettings);

export type T3AgentDriverEnv = ServerConfig;

function concise(value: string, max = 72): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function makeTextGeneration(): TextGeneration.TextGeneration["Service"] {
  return TextGeneration.TextGeneration.of({
    generateThreadTitle: (input) =>
      Effect.succeed({ title: concise(input.message) || "New thread" }),
    generateBranchName: (input) =>
      Effect.succeed({
        branch: sanitizeBranchFragment(concise(input.message, 48)) || "t3-agent-change",
      }),
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: concise(input.stagedSummary || "Update project"),
        body: "",
        ...(input.includeBranch
          ? {
              branch: sanitizeBranchFragment(concise(input.stagedSummary, 48)) || "t3-agent-change",
            }
          : {}),
      }),
    generatePrContent: (input) =>
      Effect.succeed({
        title: concise(input.commitSummary || input.headBranch),
        body: input.diffSummary.trim() || input.commitSummary.trim(),
      }),
  });
}

function modelCapabilities(reasoning: boolean) {
  return createModelCapabilities({
    optionDescriptors: reasoning
      ? [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select" as const,
            options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({
              id,
              label: id,
              ...(id === "medium" ? { isDefault: true as const } : {}),
            })),
            currentValue: "medium",
          },
        ]
      : [],
  });
}

export const T3AgentDriver: ProviderDriver<T3AgentSettings, T3AgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "T3 Agent",
    supportsMultipleInstances: true,
  },
  configSchema: T3AgentSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const effectiveConfig = { ...config, enabled } satisfies T3AgentSettings;
      const credentials = makePiCredentialStore(effectiveConfig.authPath);
      const processEnvironment = mergeProviderInstanceEnvironment(environment) as Record<
        string,
        string
      >;
      const models = builtinModels({
        credentials,
        authContext: {
          env: async (name) => processEnvironment[name] ?? process.env[name],
          fileExists: async () => false,
        },
      });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const adapter = yield* makeT3AgentAdapter({
        instanceId,
        providerId: effectiveConfig.providerId,
        sessionsRoot: `${serverConfig.stateDir}/t3-agent-sessions/${instanceId}`,
        credentials,
        environment: processEnvironment,
        models,
      });
      yield* Effect.addFinalizer(() => Effect.ignore(adapter.stopAll()));

      const snapshotEffect = Effect.promise(async (): Promise<ServerProvider> => {
        try {
          const provider = models.getProvider(effectiveConfig.providerId);
          const auth = provider ? await models.checkAuth(effectiveConfig.providerId) : undefined;
          const providerModels: ServerProviderModel[] = (provider?.getModels() ?? []).map(
            (model, index) => ({
              slug: model.id,
              name: model.name,
              isCustom: false,
              ...(index === 0 ? { isDefault: true } : {}),
              capabilities: modelCapabilities(model.reasoning),
            }),
          );
          const configured = provider !== undefined && auth !== undefined;
          return {
            instanceId,
            driver: DRIVER_KIND,
            ...(displayName ? { displayName } : { displayName: "T3 Agent" }),
            ...(accentColor ? { accentColor } : {}),
            badgeLabel: "Early Access",
            continuation: { groupKey: continuationIdentity.continuationKey },
            showInteractionModeToggle: false,
            requiresNewThreadForModelChange: false,
            enabled,
            installed: true,
            version: null,
            status: !enabled ? "disabled" : configured ? "ready" : "warning",
            auth: auth
              ? {
                  status: "authenticated",
                  type: auth.type,
                  ...(auth.source ? { label: auth.source } : {}),
                }
              : { status: "unauthenticated" },
            checkedAt: new Date().toISOString(),
            ...(!provider
              ? { message: `Unknown model provider '${effectiveConfig.providerId}'.` }
              : !auth
                ? {
                    message: `Model provider '${effectiveConfig.providerId}' is not authenticated.`,
                  }
                : {}),
            models: providerModels,
            slashCommands: [],
            skills: [],
          };
        } catch {
          return {
            instanceId,
            driver: DRIVER_KIND,
            ...(displayName ? { displayName } : { displayName: "T3 Agent" }),
            ...(accentColor ? { accentColor } : {}),
            badgeLabel: "Early Access",
            continuation: { groupKey: continuationIdentity.continuationKey },
            showInteractionModeToggle: false,
            requiresNewThreadForModelChange: false,
            enabled,
            installed: true,
            version: null,
            status: enabled ? "warning" : "disabled",
            auth: { status: "unknown" },
            checkedAt: new Date().toISOString(),
            message: "T3 Agent authentication could not be inspected.",
            models: [],
            slashCommands: [],
            skills: [],
          };
        }
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: snapshotEffect,
          refresh: snapshotEffect,
          streamChanges: Stream.empty,
        },
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
