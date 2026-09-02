// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

import type { PodmanBackend } from "./PodmanBackend.ts";

const RELAY = String.raw`
import os,select,socket,sys
s=socket.create_connection(("127.0.0.1",int(sys.argv[1])))
stdin_open=True
while True:
 ready,_,_=select.select(([s]+([sys.stdin.buffer] if stdin_open else [])),[],[])
 if sys.stdin.buffer in ready:
  data=os.read(0,65536)
  if data: s.sendall(data)
  else:
   stdin_open=False
   s.shutdown(socket.SHUT_WR)
 if s in ready:
  data=s.recv(65536)
  if not data: break
  os.write(1,data)
`;

export interface ExposedContainerPort {
  readonly containerPort: number;
  readonly hostPort: number;
  readonly url: string;
}

export class HostPortForwarder {
  private readonly forwarders = new Map<string, Promise<ExposedContainerPort>>();

  expose(
    containerName: string,
    containerPort: number,
    podman: PodmanBackend,
  ): Promise<ExposedContainerPort> {
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65_535) {
      return Promise.reject(new Error("Container port must be an integer between 1 and 65535."));
    }
    const key = `${containerName}:${containerPort}`;
    const existing = this.forwarders.get(key);
    if (existing) return existing;
    const created = new Promise<ExposedContainerPort>((resolve, reject) => {
      const server = NodeNet.createServer((socket) => {
        const relay = podman.spawn(
          ["exec", "--interactive", containerName, "python3", "-c", RELAY, String(containerPort)],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        socket.pipe(relay.stdin);
        relay.stdout.pipe(socket);
        relay.stderr.resume();
        socket.on("error", () => relay.kill("SIGTERM"));
        socket.on("close", () => relay.kill("SIGTERM"));
        relay.on("error", () => socket.destroy());
        relay.on("close", () => socket.end());
      });
      server.once("error", (cause) => {
        this.forwarders.delete(key);
        reject(cause);
      });
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          this.forwarders.delete(key);
          reject(new Error("Could not allocate a host port."));
          return;
        }
        server.unref();
        resolve({
          containerPort,
          hostPort: address.port,
          url: `http://127.0.0.1:${address.port}`,
        });
      });
    });
    this.forwarders.set(key, created);
    return created;
  }
}

export const hostPortForwarder = new HostPortForwarder();
