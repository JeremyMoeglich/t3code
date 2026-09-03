// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import {
  AgentContainerId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeT3AgentAdapter } from "./T3AgentAdapter.ts";

const NO_CREDENTIALS: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_providerId, fn) => fn(undefined),
  delete: async () => undefined,
};

function testModels(options?: { contextWindow?: number }) {
  const faux = fauxProvider({
    provider: "t3-agent-test",
    models: [
      {
        id: "t3-agent-test-model",
        name: "T3 Agent Test Model",
        reasoning: true,
        contextWindow: options?.contextWindow ?? 64_000,
        maxTokens: 8_000,
      },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

const startInput = (
  threadId: ThreadId,
  cwd: string,
  runtimeMode: "approval-required" | "full-access" = "full-access",
) => ({
  threadId,
  providerInstanceId: ProviderInstanceId.make("t3Agent"),
  cwd,
  runtimeMode,
  modelSelection: {
    instanceId: ProviderInstanceId.make("t3Agent"),
    model: "t3-agent-test-model",
  },
});

it.effect("runs an Agent turn, persists it, restores it, and rolls it back", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const { faux, models } = testModels();
    faux.setResponses([fauxAssistantMessage("hello from T3 Agent")]);
    const adapter = yield* makeT3AgentAdapter({
      instanceId: ProviderInstanceId.make("t3Agent"),
      providerId: "t3-agent-test",
      sessionsRoot: NodePath.join(root, "sessions"),
      credentials: NO_CREDENTIALS,
      models,
    });
    const threadId = ThreadId.make("t3-agent-persist-thread");
    const events: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<void>();
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkChild,
    );

    yield* adapter.startSession(startInput(threadId, root));
    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"));

    assert.equal(
      events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
        .join(""),
      "hello from T3 Agent",
    );
    const configured = events.find((event) => event.type === "session.configured");
    assert.deepEqual(
      configured?.type === "session.configured" ? configured.payload.config.tools : undefined,
      ["read", "bash", "edit", "write"],
    );
    assert.equal((yield* adapter.readThread(threadId)).turns.length, 1);
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);

    faux.setResponses([
      (context) => {
        assert.isTrue(
          context.messages.some(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message).includes("hello from T3 Agent"),
          ),
        );
        return fauxAssistantMessage("restored");
      },
    ]);
    const restored = yield* makeT3AgentAdapter({
      instanceId: ProviderInstanceId.make("t3Agent"),
      providerId: "t3-agent-test",
      sessionsRoot: NodePath.join(root, "sessions"),
      credentials: NO_CREDENTIALS,
      models,
    });
    const restoredCompleted = yield* Deferred.make<void>();
    const restoredFiber = yield* restored.streamEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.completed"
          ? Deferred.succeed(restoredCompleted, undefined)
          : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* restored.startSession(startInput(threadId, root));
    yield* restored.sendTurn({ threadId, input: "continue" });
    yield* Deferred.await(restoredCompleted).pipe(Effect.timeout("2 seconds"));
    assert.equal((yield* restored.readThread(threadId)).turns.length, 2);
    assert.equal((yield* restored.rollbackThread(threadId, 1)).turns.length, 1);
    yield* restored.stopSession(threadId);
    yield* Fiber.interrupt(restoredFiber);
  }),
);

it.effect("runs host tools without runtime approval modes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-approval-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const { faux, models } = testModels();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf approved" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const adapter = yield* makeT3AgentAdapter({
      instanceId: ProviderInstanceId.make("t3Agent"),
      providerId: "t3-agent-test",
      sessionsRoot: NodePath.join(root, "sessions"),
      credentials: NO_CREDENTIALS,
      models,
    });
    const threadId = ThreadId.make("t3-agent-approval-thread");
    const completed = yield* Deferred.make<void>();
    const events: ProviderRuntimeEvent[] = [];
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkChild,
    );
    const session = yield* adapter.startSession(startInput(threadId, root, "approval-required"));
    assert.equal(session.runtimeMode, "full-access");
    yield* adapter.sendTurn({ threadId, input: "run it" });
    yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"));
    assert.isFalse(events.some((event) => event.type === "request.opened"));
    const bashCompletion = events.find(
      (event) => event.type === "item.completed" && event.payload.itemType === "command_execution",
    );
    const output =
      bashCompletion?.type === "item.completed" &&
      bashCompletion.payload.data !== null &&
      typeof bashCompletion.payload.data === "object"
        ? (bashCompletion.payload.data as { output?: unknown }).output
        : undefined;
    assert.isTrue(typeof output === "string" && output.includes("approved"));
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);
  }),
);

it.effect("rebuilds the tool environment when a thread changes execution target", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-target-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const { models } = testModels();
    const resolvedTargets: string[] = [];
    const adapter = yield* makeT3AgentAdapter({
      instanceId: ProviderInstanceId.make("t3Agent"),
      providerId: "t3-agent-test",
      sessionsRoot: NodePath.join(root, "sessions"),
      credentials: NO_CREDENTIALS,
      models,
      resolveExecutionEnvironment: (input) =>
        Effect.sync(() => {
          resolvedTargets.push(input.executionTarget?.kind ?? "host");
          return new NodeExecutionEnv({ cwd: root });
        }),
    });
    const threadId = ThreadId.make("t3-agent-target-thread");
    yield* adapter.startSession(startInput(threadId, root));
    yield* adapter.startSession(startInput(threadId, root));
    yield* adapter.startSession({
      ...startInput(threadId, root),
      executionTarget: {
        kind: "container",
        containerId: AgentContainerId.make("container-1"),
      },
    });

    assert.deepEqual(resolvedTargets, ["host", "container"]);
    assert.equal((yield* adapter.listSessions())[0]?.executionTarget?.kind, "container");
    yield* adapter.stopSession(threadId);
  }),
);

it.effect("offers expose_port only when the execution environment supports it", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-port-tool-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const { faux, models } = testModels();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("expose_port", { port: 3_000 }), {
        stopReason: "toolUse",
      }),
      (context) => {
        assert.isTrue(JSON.stringify(context.messages).includes("http://127.0.0.1:43123"));
        return fauxAssistantMessage("shared the URL");
      },
    ]);
    const env = Object.assign(new NodeExecutionEnv({ cwd: root }), {
      exposePort: (containerPort: number) =>
        Promise.resolve({
          containerPort,
          hostPort: 43_123,
          url: "http://127.0.0.1:43123",
        }),
    });
    const adapter = yield* makeT3AgentAdapter({
      instanceId: ProviderInstanceId.make("t3Agent"),
      providerId: "t3-agent-test",
      sessionsRoot: NodePath.join(root, "sessions"),
      credentials: NO_CREDENTIALS,
      models,
      resolveExecutionEnvironment: () => Effect.succeed(env),
    });
    const threadId = ThreadId.make("t3-agent-port-tool-thread");
    const events: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<void>();
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* adapter.startSession({
      ...startInput(threadId, root),
      executionTarget: {
        kind: "container",
        containerId: AgentContainerId.make("container-port-tool"),
      },
    });
    yield* adapter.sendTurn({ threadId, input: "start a server" });
    yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"));
    const configured = events.find((event) => event.type === "session.configured");
    assert.deepEqual(
      configured?.type === "session.configured" ? configured.payload.config.tools : undefined,
      ["read", "bash", "edit", "write", "expose_port"],
    );
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);
  }),
);

it.effect("uses the agent core's built-in compaction before an over-window turn", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-compact-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const sessionsRoot = NodePath.join(root, "sessions");
    const threadId = ThreadId.make("t3-agent-compact-thread");
    const seedEnv = new NodeExecutionEnv({ cwd: sessionsRoot });
    const seedRepo = new JsonlSessionRepo({ fs: seedEnv, sessionsRoot });
    const seed = yield* Effect.promise(() => seedRepo.create({ id: threadId, cwd: root }));
    yield* Effect.promise(() =>
      seed.appendMessage({
        role: "user",
        content: "retain the important context",
        timestamp: 1,
      }),
    );
    yield* Effect.promise(() =>
      seed.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(220_000) }],
        api: "faux",
        provider: "t3-agent-test",
        model: "t3-agent-test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      }),
    );

    const { faux, models } = testModels({ contextWindow: 32_000 });
    faux.setResponses([
      fauxAssistantMessage("## Goal\nContinue the seeded task."),
      fauxAssistantMessage("after compaction"),
    ]);
    const adapter = yield* makeT3AgentAdapter({
      instanceId: ProviderInstanceId.make("t3Agent"),
      providerId: "t3-agent-test",
      sessionsRoot,
      credentials: NO_CREDENTIALS,
      models,
    });
    const events: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<void>();
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* adapter.startSession(startInput(threadId, root));
    yield* adapter.sendTurn({ threadId, input: "continue now" });
    yield* Deferred.await(completed).pipe(Effect.timeout("3 seconds"));
    assert.isTrue(
      events.some(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      ),
    );
    assert.equal(faux.state.callCount, 2);
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);
  }),
);
