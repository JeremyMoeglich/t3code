// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
import {
  Agent,
  buildSessionContext,
  compact,
  convertToLlm,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  JsonlSessionRepo,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentHarnessTool,
  type AgentMessage,
  type AgentTool,
  type Entry,
  type ExecutionEnv,
  type Session,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type AssistantMessage,
  type CredentialStore,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type RuntimeMode,
  type ProviderInstanceId,
  type ThreadExecutionTarget,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("t3Agent");
const SYSTEM_PROMPT = `You are a coding agent running inside T3 Code.
Work directly in the current working directory. Inspect before changing files, keep edits focused,
and verify the result. You have only read, bash, edit, and write tools in the selected execution environment.`;
const TURN_START = "t3-turn-start";
const TURN_END = "t3-turn-end";

interface T3AgentSessionContext {
  readonly session: ProviderSession;
  readonly history: Session;
  readonly env: ExecutionEnv;
  readonly agent: Agent;
  readonly approvedTools: Set<string>;
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  interrupted: boolean;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly requestType: "command_execution_approval" | "file_change_approval";
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

export interface T3AgentAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly providerId: string;
  readonly sessionsRoot: string;
  readonly credentials: CredentialStore;
  readonly environment?: Readonly<Record<string, string>>;
  readonly models?: Models;
  readonly resolveExecutionEnvironment?: (input: {
    readonly cwd: string;
    readonly executionTarget: ThreadExecutionTarget | undefined;
  }) => Effect.Effect<ExecutionEnv, Error>;
}

function expandHome(path: string): string {
  return path === "~"
    ? NodeOS.homedir()
    : path.startsWith("~/")
      ? NodePath.join(NodeOS.homedir(), path.slice(2))
      : path;
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((content) =>
      content.type === "text"
        ? [content.text]
        : content.type === "thinking"
          ? [content.thinking]
          : [],
    )
    .join("\n");
}

function toolResultText(result: unknown): string {
  if (result === null || typeof result !== "object") return String(result ?? "");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .flatMap((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? [String((part as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}

function jsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(jsonValue) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    ) as T;
  }
  return value;
}

function wrapHarnessTool(tool: AgentHarnessTool<{ env: ExecutionEnv }>, env: ExecutionEnv) {
  const wrapped: AgentTool = {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env }),
  };
  return wrapped;
}

function thinkingLevel(input: ProviderSendTurnInput): Agent["state"]["thinkingLevel"] {
  const raw =
    getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(input.modelSelection, "effort");
  return raw === "off" ||
    raw === "minimal" ||
    raw === "low" ||
    raw === "medium" ||
    raw === "high" ||
    raw === "xhigh" ||
    raw === "max"
    ? raw
    : "medium";
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function toolItemType(toolName: string): "command_execution" | "file_change" | "dynamic_tool_call" {
  if (toolName === "bash") return "command_execution";
  if (toolName === "edit" || toolName === "write") return "file_change";
  return "dynamic_tool_call";
}

function approvalType(toolName: string): PendingApproval["requestType"] {
  return toolName === "bash" ? "command_execution_approval" : "file_change_approval";
}

function shouldApproveAutomatically(
  runtimeMode: RuntimeMode,
  toolName: string,
  approvedTools: ReadonlySet<string>,
): boolean {
  if (toolName === "read" || runtimeMode === "full-access" || approvedTools.has(toolName)) {
    return true;
  }
  return runtimeMode === "auto-accept-edits" && (toolName === "edit" || toolName === "write");
}

function makeSessionSnapshot(context: T3AgentSessionContext): ProviderSession {
  const now = new Date().toISOString();
  return {
    ...context.session,
    status: context.agent.state.isStreaming ? "running" : "ready",
    ...(context.activeTurnId ? { activeTurnId: context.activeTurnId } : {}),
    updatedAt: now,
  };
}

export const makeT3AgentAdapter = Effect.fn("makeT3AgentAdapter")(function* (
  options: T3AgentAdapterOptions,
): Effect.fn.Return<ProviderAdapterShape<ProviderAdapterError>, never, never> {
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, T3AgentSessionContext>();
  const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
  const models =
    options.models ??
    builtinModels({
      credentials: options.credentials,
      authContext: {
        env: async (name) => options.environment?.[name] ?? process.env[name],
        fileExists: async (path) =>
          NodeFSP.access(expandHome(path)).then(
            () => true,
            () => false,
          ),
      },
    });
  const repoEnv = new NodeExecutionEnv({ cwd: options.sessionsRoot });
  const repo = new JsonlSessionRepo({ fs: repoEnv, sessionsRoot: options.sessionsRoot });

  const emit = (event: ProviderRuntimeEvent): Promise<void> =>
    runPromise(Queue.offer(eventQueue, event)).then(() => undefined);
  const base = (context: T3AgentSessionContext, turnId?: TurnId) => ({
    eventId: EventId.make(uuidv7()),
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<T3AgentSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const resolveModel = (
    modelId: string | undefined,
  ): Effect.Effect<Model<any>, ProviderAdapterError> => {
    const available = models.getModels(options.providerId);
    const model = modelId
      ? models.getModel(options.providerId, modelId)
      : (available.find((candidate) => candidate.id.includes("gpt-5.6-luna")) ?? available[0]);
    return model
      ? Effect.succeed(model)
      : Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "resolveModel",
            issue: modelId
              ? `Model '${modelId}' is not available from provider '${options.providerId}'.`
              : `Provider '${options.providerId}' has no models.`,
          }),
        );
  };

  const pathEntries = (history: Session): Promise<Entry[]> =>
    history.findEntriesOnBranch({ order: "oldestFirst" });

  const maybeCompact = async (context: T3AgentSessionContext, signal?: AbortSignal) => {
    const entries = await pathEntries(context.history);
    const currentMessages = buildSessionContext(entries).messages;
    if (
      !shouldCompact(
        estimateContextTokens(currentMessages).tokens,
        context.agent.state.model.contextWindow,
        DEFAULT_COMPACTION_SETTINGS,
      )
    ) {
      return currentMessages;
    }
    const prepared = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
    if (!prepared.ok || prepared.value === undefined) {
      return buildSessionContext(entries).messages;
    }
    const result = await compact(
      prepared.value,
      models,
      context.agent.state.model,
      undefined,
      signal,
      context.agent.state.thinkingLevel,
    );
    if (!result.ok) return buildSessionContext(entries).messages;
    await context.history.appendEntry(
      {
        type: "compaction",
        id: uuidv7(),
        summary: result.value.summary,
        retainedTail: result.value.retainedTail,
        tokensBefore: result.value.tokensBefore,
        ...(result.value.details !== undefined ? { details: result.value.details } : {}),
        ...(result.value.usage !== undefined ? { usage: result.value.usage } : {}),
      },
      "main",
    );
    await emit({
      ...base(context, context.activeTurnId),
      type: "thread.state.changed",
      payload: { state: "compacted" },
    });
    return buildSessionContext(await pathEntries(context.history)).messages;
  };

  const requestApproval = async (
    context: T3AgentSessionContext,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ) => {
    if (shouldApproveAutomatically(context.session.runtimeMode, toolName, context.approvedTools)) {
      return undefined;
    }
    const requestId = ApprovalRequestId.make(uuidv7());
    const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
      pendingApprovals.set(requestId, {
        threadId: context.session.threadId,
        requestType: approvalType(toolName),
        resolve,
      });
      const abort = () => resolve("cancel");
      signal?.addEventListener("abort", abort, { once: true });
      void emit({
        ...base(context, context.activeTurnId),
        type: "request.opened",
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          requestType: approvalType(toolName),
          detail: `Allow T3 Agent to run ${toolName}?`,
          args,
          options: [
            { decision: "accept", label: "Allow once" },
            { decision: "acceptForSession", label: "Allow this session" },
            { decision: "decline", label: "Decline" },
          ],
        },
      });
    });
    pendingApprovals.delete(requestId);
    if (decision === "acceptForSession" || decision === "acceptAlways") {
      context.approvedTools.add(toolName);
    }
    await emit({
      ...base(context, context.activeTurnId),
      type: "request.resolved",
      requestId: RuntimeRequestId.make(requestId),
      payload: { requestType: approvalType(toolName), decision },
    });
    return decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways"
      ? undefined
      : { block: true as const, reason: "The user declined this tool call." };
  };

  const handleAgentEvent = async (context: T3AgentSessionContext, event: AgentEvent) => {
    const turnId = context.activeTurnId;
    if (event.type === "message_end") {
      await context.history.appendMessage(jsonValue(event.message));
    }
    if (!turnId) return;

    if (event.type === "message_start" && isAssistant(event.message)) {
      context.activeAssistantItemId = RuntimeItemId.make(uuidv7());
      await emit({
        ...base(context, turnId),
        type: "item.started",
        itemId: context.activeAssistantItemId,
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      return;
    }
    if (event.type === "message_update" && isAssistant(event.message)) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && context.activeAssistantItemId) {
        await emit({
          ...base(context, turnId),
          type: "content.delta",
          itemId: context.activeAssistantItemId,
          payload: {
            streamKind: "assistant_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
        });
      }
      if (update.type === "thinking_delta") {
        if (!context.activeReasoningItemId) {
          context.activeReasoningItemId = RuntimeItemId.make(uuidv7());
          await emit({
            ...base(context, turnId),
            type: "item.started",
            itemId: context.activeReasoningItemId,
            payload: { itemType: "reasoning", status: "inProgress" },
          });
        }
        await emit({
          ...base(context, turnId),
          type: "content.delta",
          itemId: context.activeReasoningItemId,
          payload: {
            streamKind: "reasoning_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
        });
      }
      return;
    }
    if (event.type === "message_end" && isAssistant(event.message)) {
      if (context.activeReasoningItemId) {
        await emit({
          ...base(context, turnId),
          type: "item.completed",
          itemId: context.activeReasoningItemId,
          payload: { itemType: "reasoning", status: "completed" },
        });
        context.activeReasoningItemId = undefined;
      }
      if (context.activeAssistantItemId) {
        await emit({
          ...base(context, turnId),
          type: "item.completed",
          itemId: context.activeAssistantItemId,
          payload: {
            itemType: "assistant_message",
            status: event.message.stopReason === "error" ? "failed" : "completed",
            data: { text: messageText(event.message) },
          },
        });
      }
      const usage = event.message.usage;
      await emit({
        ...base(context, turnId),
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens: usage.totalTokens,
            inputTokens: usage.input,
            cachedInputTokens: usage.cacheRead,
            outputTokens: usage.output,
            reasoningOutputTokens: usage.reasoning,
            maxTokens: context.agent.state.model.contextWindow,
            compactsAutomatically: true,
            autoCompactThreshold:
              context.agent.state.model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
          },
        },
      });
      return;
    }
    if (event.type === "tool_execution_start") {
      await emit({
        ...base(context, turnId),
        type: "item.started",
        itemId: RuntimeItemId.make(event.toolCallId),
        payload: {
          itemType: toolItemType(event.toolName),
          status: "inProgress",
          title: event.toolName,
          data: { args: event.args },
        },
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      await emit({
        ...base(context, turnId),
        type: "item.updated",
        itemId: RuntimeItemId.make(event.toolCallId),
        payload: {
          itemType: toolItemType(event.toolName),
          status: "inProgress",
          title: event.toolName,
          data: { output: toolResultText(event.partialResult) },
        },
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      await emit({
        ...base(context, turnId),
        type: "item.completed",
        itemId: RuntimeItemId.make(event.toolCallId),
        payload: {
          itemType: toolItemType(event.toolName),
          status: event.isError ? "failed" : "completed",
          title: event.toolName,
          data: { output: toolResultText(event.result) },
        },
      });
      return;
    }
    if (event.type === "agent_end") {
      const lastAssistant = event.messages.toReversed().find(isAssistant);
      const state = context.interrupted
        ? "interrupted"
        : lastAssistant?.stopReason === "error"
          ? "failed"
          : "completed";
      await context.history.appendCustomEntry(TURN_END, { turnId, state });
      await emit({
        ...base(context, turnId),
        type: "turn.completed",
        payload: {
          state,
          stopReason: lastAssistant?.stopReason ?? null,
          ...(lastAssistant?.errorMessage ? { errorMessage: lastAssistant.errorMessage } : {}),
        },
      });
      context.activeTurnId = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.interrupted = false;
      context.agent.state.messages = buildSessionContext(
        await pathEntries(context.history),
      ).messages;
      await emit({
        ...base(context),
        type: "session.state.changed",
        payload: { state: "ready" },
      });
      await emit({
        ...base(context),
        type: "thread.state.changed",
        payload: { state: "idle" },
      });
    }
  };

  const startSession = (input: ProviderSessionStartInput) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (
        existing &&
        existing.session.cwd === input.cwd &&
        Equal.equals(
          existing.session.executionTarget ?? { kind: "host" },
          input.executionTarget ?? { kind: "host" },
        )
      ) {
        return makeSessionSnapshot(existing);
      }
      if (existing) {
        if (existing.agent.state.isStreaming) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The execution target cannot change while a turn is running.",
          });
        }
        yield* Effect.promise(() => existing.env.cleanup());
        sessions.delete(input.threadId);
      }
      const cwd = input.cwd;
      if (!cwd) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "A working directory is required.",
        });
      }
      const model = yield* resolveModel(input.modelSelection?.model);
      const history = yield* Effect.tryPromise({
        try: async () => {
          const metadata = (await repo.list()).find((candidate) => candidate.id === input.threadId);
          return metadata
            ? repo.open(metadata)
            : repo.create({ id: input.threadId, cwd, metadata: { t3ThreadId: input.threadId } });
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "startSession",
            detail: "Could not open the T3 Agent session.",
            cause,
          }),
      });
      const env = yield* (
        options.resolveExecutionEnvironment
          ? options.resolveExecutionEnvironment({ cwd, executionTarget: input.executionTarget })
          : Effect.succeed(
              new NodeExecutionEnv({
                cwd,
                shellEnv: { ...process.env, ...options.environment },
              }),
            )
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail:
                cause instanceof Error
                  ? cause.message
                  : "Could not prepare the execution environment.",
              cause,
            }),
        ),
      );
      const now = new Date().toISOString();
      const restoredMessages = yield* Effect.promise(() =>
        pathEntries(history).then((entries) => buildSessionContext(entries).messages),
      );
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
        model: model.id,
        threadId: input.threadId,
        resumeCursor: { sessionId: input.threadId },
        createdAt: now,
        updatedAt: now,
      };
      let context!: T3AgentSessionContext;
      const tools = [createReadTool(), createBashTool(), createEditTool(), createWriteTool()].map(
        (tool) => wrapHarnessTool(tool, env),
      );
      const agent = new Agent({
        initialState: {
          systemPrompt: SYSTEM_PROMPT,
          model,
          thinkingLevel: "medium",
          tools,
          messages: restoredMessages,
        },
        convertToLlm,
        streamFn: models.streamSimple.bind(models),
        sessionId: input.threadId,
        transformContext: (_messages, signal) => maybeCompact(context, signal),
        beforeToolCall: ({ toolCall, args }, signal) =>
          requestApproval(context, toolCall.name, args, signal),
        toolExecution: "sequential",
      });
      context = {
        session,
        history,
        env,
        agent,
        approvedTools: new Set(),
        activeTurnId: undefined,
        activeAssistantItemId: undefined,
        activeReasoningItemId: undefined,
        interrupted: false,
      };
      agent.subscribe((event) => handleAgentEvent(context, event));
      sessions.set(input.threadId, context);
      yield* Effect.promise(() =>
        Promise.all([
          emit({
            ...base(context),
            type: "session.started",
            payload: { resume: session.resumeCursor },
          }),
          emit({
            ...base(context),
            type: "session.configured",
            payload: {
              config: {
                providerId: options.providerId,
                model: model.id,
                tools: tools.map((tool) => tool.name),
              },
            },
          }),
          emit({
            ...base(context),
            type: "thread.started",
            payload: { providerThreadId: input.threadId },
          }),
          emit({ ...base(context), type: "session.state.changed", payload: { state: "ready" } }),
        ]).then(() => undefined),
      );
      return session;
    });

  const readSnapshot = (context: T3AgentSessionContext): Promise<ProviderThreadSnapshot> =>
    pathEntries(context.history).then((entries) => ({
      threadId: context.session.threadId,
      turns: entries.flatMap((entry) => {
        if (entry.type !== "custom" || entry.customType !== TURN_END) return [];
        const turnId = (entry.data as { turnId?: unknown } | undefined)?.turnId;
        return typeof turnId === "string" ? [{ id: TurnId.make(turnId), items: [] }] : [];
      }),
    }));

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn: (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (input.attachments && input.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Attachments are not supported by T3 Agent yet.",
          });
        }
        if (!input.input) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A text message is required.",
          });
        }
        if (input.modelSelection?.model) {
          context.agent.state.model = yield* resolveModel(input.modelSelection.model);
        }
        context.agent.state.thinkingLevel = thinkingLevel(input);
        if (context.agent.state.isStreaming && context.activeTurnId) {
          context.agent.steer({ role: "user", content: input.input, timestamp: Date.now() });
          return {
            threadId: input.threadId,
            turnId: context.activeTurnId,
            resumeCursor: context.session.resumeCursor,
          } satisfies ProviderTurnStartResult;
        }
        const turnId = TurnId.make(uuidv7());
        context.activeTurnId = turnId;
        context.interrupted = false;
        yield* Effect.tryPromise({
          try: () =>
            context.history.appendCustomEntry(TURN_START, { turnId }).then(() => undefined),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Could not persist the turn start.",
              cause,
            }),
        });
        yield* Effect.promise(() =>
          Promise.all([
            emit({
              ...base(context, turnId),
              type: "turn.started",
              payload: {
                model: context.agent.state.model.id,
                effort: context.agent.state.thinkingLevel,
              },
            }),
            emit({
              ...base(context, turnId),
              type: "session.state.changed",
              payload: { state: "running" },
            }),
            emit({
              ...base(context, turnId),
              type: "thread.state.changed",
              payload: { state: "active" },
            }),
          ]).then(() => undefined),
        );
        void context.agent.prompt(input.input).catch(async (cause: unknown) => {
          const message =
            (cause instanceof Error ? cause.message : String(cause)).trim() ||
            "T3 Agent turn failed.";
          await emit({
            ...base(context, turnId),
            type: "runtime.error",
            payload: {
              class: "provider_error",
              message,
            },
          });
          if (context.activeTurnId !== turnId) return;
          await context.history
            .appendCustomEntry(TURN_END, { turnId, state: "failed" })
            .catch(() => undefined);
          await emit({
            ...base(context, turnId),
            type: "turn.completed",
            payload: { state: "failed", stopReason: "error", errorMessage: message },
          });
          context.activeTurnId = undefined;
          context.activeAssistantItemId = undefined;
          context.activeReasoningItemId = undefined;
          await emit({
            ...base(context),
            type: "session.state.changed",
            payload: { state: "error", reason: message },
          });
        });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      }),
    interruptTurn: (threadId, turnId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) => {
          if (turnId && context.activeTurnId && turnId !== context.activeTurnId) {
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "interruptTurn",
                issue: `Turn '${turnId}' is not active.`,
              }),
            );
          }
          context.interrupted = true;
          context.agent.abort();
          return Effect.promise(() => context.agent.waitForIdle());
        }),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        const pending = pendingApprovals.get(requestId);
        if (!pending || pending.threadId !== threadId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `Unknown approval request '${requestId}'.`,
          });
        }
        pending.resolve(decision);
      }),
    respondToUserInput: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToUserInput",
              detail: "Structured user input is not supported by this minimal harness.",
            }),
          ),
        ),
      ),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.interrupted = true;
        context.agent.abort();
        yield* Effect.promise(() => context.agent.waitForIdle());
        for (const [requestId, pending] of pendingApprovals) {
          if (pending.threadId === threadId) {
            pending.resolve("cancel");
            pendingApprovals.delete(requestId);
          }
        }
        yield* Effect.promise(() => context.env.cleanup());
        sessions.delete(threadId);
        yield* Effect.promise(() =>
          emit({
            ...base(context),
            type: "session.exited",
            payload: { reason: "Session stopped", exitKind: "graceful" },
          }),
        );
      }),
    listSessions: () => Effect.succeed([...sessions.values()].map(makeSessionSnapshot)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => readSnapshot(context),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "readThread",
                detail: "Could not read the T3 Agent session.",
                cause,
              }),
          }),
        ),
      ),
    rollbackThread: (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: async () => {
              if (context.agent.state.isStreaming) {
                throw new Error("Cannot roll back while a turn is active.");
              }
              const entries = await pathEntries(context.history);
              const starts = entries.filter(
                (entry) => entry.type === "custom" && entry.customType === TURN_START,
              );
              const target = starts.at(-numTurns);
              if (target) await context.history.moveLane("main", target.parentId);
              context.agent.state.messages = buildSessionContext(
                await pathEntries(context.history),
              ).messages;
              return readSnapshot(context);
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "rollbackThread",
                detail:
                  cause instanceof Error
                    ? cause.message
                    : "Could not roll back the T3 Agent session.",
                cause,
              }),
          }),
        ),
      ),
    stopAll: () =>
      Effect.forEach([...sessions.keys()], (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          context.interrupted = true;
          context.agent.abort();
          yield* Effect.promise(() => context.agent.waitForIdle());
          yield* Effect.promise(() => context.env.cleanup());
          sessions.delete(threadId);
        }),
      ).pipe(Effect.asVoid),
    streamEvents: Stream.fromQueue(eventQueue),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
