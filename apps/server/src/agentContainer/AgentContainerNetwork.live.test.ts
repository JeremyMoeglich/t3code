// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { AgentContainerId } from "@t3tools/contracts";
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

it.runIf(process.env.T3_LIVE_PODMAN_NETWORK === "1")(
  "enforces live egress changes and relays an internal port to host loopback",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-network-live-"));
    const workspacePath = NodePath.join(root, "workspace");
    await NodeFSP.mkdir(workspacePath);
    const id = AgentContainerId.make(`live-${process.pid}`);
    const manager = makeAgentContainerManager({
      stateDir: NodePath.join(root, "state"),
    } as ServerConfig["Service"]);
    try {
      await Effect.runPromise(manager.configure({ id, workspacePath, networkPolicy: "" }));
      const env = await Effect.runPromise(manager.executionEnvironment({ id, workspacePath }));
      const blocked = await env.exec("curl --silent --show-error --max-time 2 https://example.com");
      assert.isTrue(blocked.ok && blocked.value.exitCode !== 0);

      await Effect.runPromise(
        manager.configure({
          id,
          workspacePath,
          networkPolicy: "allow 0.0.0.0/0\nallow ::/0",
        }),
      );
      const allowed = await env.exec(
        "curl --silent --show-error --max-time 10 https://example.com",
      );
      assert.isTrue(allowed.ok && allowed.value.exitCode === 0);

      const server = await env.exec(
        "python3 -m http.server 8123 --bind 127.0.0.1 >/tmp/t3-http.log 2>&1 &",
      );
      assert.isTrue(server.ok && server.value.exitCode === 0);
      const exposed = await env.exposePort(8123);
      const response = await get(exposed.url);
      assert.equal(response.status, 200);
      assert.include(response.body, "Directory listing");

      await Effect.runPromise(
        manager.configure({
          id,
          workspacePath,
          networkPolicy: "allow dns tcp,udp 53",
        }),
      );
      const restricted = await env.exec(
        "curl --silent --show-error --max-time 2 https://example.com",
      );
      assert.isTrue(restricted.ok && restricted.value.exitCode !== 0);
      await env.cleanup();
    } finally {
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
    }
  },
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
        "localhost/t3code-agent-base:latest",
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
