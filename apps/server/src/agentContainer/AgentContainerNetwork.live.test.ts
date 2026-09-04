// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { AgentContainerId, AgentContainerImageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerConfig } from "../config.ts";
import { makeAgentContainerManager } from "./AgentContainerManager.ts";
import { localPodmanBackend } from "./PodmanBackend.ts";
import { PodmanExecutionEnv } from "./PodmanExecutionEnv.ts";

function get(url: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
  });
}

it.effect.runIf(process.env.T3_LIVE_PODMAN_NETWORK === "1")(
  "enforces live egress changes and relays an internal port to host loopback",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-network-live-")),
      );
      const workspacePath = NodePath.join(root, "workspace");
      yield* Effect.promise(() => NodeFSP.mkdir(workspacePath));
      const imagePath = NodePath.join(root, "container-images", "containerfiles", "live-test");
      yield* Effect.promise(() => NodeFSP.mkdir(imagePath, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(imagePath, "Containerfile"),
          "FROM localhost/t3code-agent-base:3\n",
        ),
      );
      const id = AgentContainerId.make(`live-${process.pid}`);
      const imageId = AgentContainerImageId.make("folder:live-test");
      const manager = makeAgentContainerManager({
        baseDir: root,
        stateDir: NodePath.join(root, "state"),
        worktreesDir: NodePath.join(root, "worktrees"),
      } as ServerConfig["Service"]);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const ids = await localPodmanBackend.run([
            "ps",
            "-a",
            "--filter",
            `label=dev.t3code.agent-container.id=${id}`,
            "--format",
            "{{.ID}}",
          ]);
          for (const containerId of ids.stdout.split(/\s+/).filter(Boolean)) {
            await localPodmanBackend.run(["rm", "--force", containerId]);
          }
          await NodeFSP.rm(root, { recursive: true, force: true });
        }),
      );

      yield* manager.configure({
        id,
        workspacePath,
        networkMode: "custom",
        networkPolicy: "",
        imageId,
      });
      const env = yield* manager.executionEnvironment({ id, workspacePath });
      const blocked = yield* Effect.promise(() =>
        env.exec("curl --silent --show-error --max-time 2 https://example.com"),
      );
      assert.isTrue(blocked.ok && blocked.value.exitCode !== 0);

      yield* manager.configure({
        id,
        workspacePath,
        networkMode: "internet",
        networkPolicy: "allow 0.0.0.0/0\nallow ::/0",
        imageId,
      });
      const allowed = yield* Effect.promise(() =>
        env.exec("curl --silent --show-error --max-time 10 https://example.com"),
      );
      assert.isTrue(allowed.ok && allowed.value.exitCode === 0);

      const server = yield* Effect.promise(() =>
        env.exec("python3 -m http.server 8123 --bind 127.0.0.1 >/tmp/t3-http.log 2>&1 &"),
      );
      assert.isTrue(server.ok && server.value.exitCode === 0);
      const exposed = yield* Effect.promise(() => env.exposePort(8123));
      const response = yield* Effect.promise(() => get(exposed.url));
      assert.equal(response.status, 200);
      assert.include(response.body, "Directory listing");

      yield* manager.configure({
        id,
        workspacePath,
        networkMode: "custom",
        networkPolicy: "allow dns tcp,udp 53",
        imageId,
      });
      const restricted = yield* Effect.promise(() =>
        env.exec("curl --silent --show-error --max-time 2 https://example.com"),
      );
      assert.isTrue(restricted.ok && restricted.value.exitCode !== 0);
      yield* Effect.promise(() => env.cleanup());
    }),
  30_000,
);

it.runIf(process.env.T3_LIVE_PODMAN === "1")(
  "relays an internal port without publishing it through Podman",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-port-live-"));
    const name = `t3-agent-port-live-${process.pid}`;
    try {
      const created = await localPodmanBackend.run([
        "create",
        "--name",
        name,
        "--network",
        "none",
        "--volume",
        `${root}:/workspace:rw`,
        "--workdir",
        "/workspace",
        "localhost/t3code-agent-base:3",
      ]);
      assert.equal(created.exitCode, 0);
      assert.equal((await localPodmanBackend.run(["start", name])).exitCode, 0);
      const env = new PodmanExecutionEnv(name);
      const server = await env.exec(
        "python3 -m http.server 8123 --bind 127.0.0.1 >/tmp/t3-http.log 2>&1 &",
      );
      assert.isTrue(server.ok && server.value.exitCode === 0);
      const exposed = await env.exposePort(8123);
      const response = await get(exposed.url);
      assert.equal(response.status, 200);
      assert.include(response.body, "Directory listing");
      const inspect = await localPodmanBackend.run([
        "inspect",
        name,
        "--format",
        "{{json .HostConfig.PortBindings}}",
      ]);
      assert.equal(inspect.stdout.trim(), "{}");
      await env.cleanup();
    } finally {
      await localPodmanBackend.run(["rm", "--force", name]);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
