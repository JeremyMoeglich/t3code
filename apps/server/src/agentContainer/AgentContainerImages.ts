// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  AgentContainerImageId,
  DEFAULT_AGENT_CONTAINER_IMAGE_ID,
  type AgentContainerImageDefinition,
} from "@t3tools/contracts";

export interface AgentContainerImage extends AgentContainerImageDefinition {
  readonly contextPath?: string;
  readonly containerfilePath?: string;
  readonly imageReference?: string;
}

function folderImage(input: {
  readonly imagesDirectory: string;
  readonly directoryName: string;
}): AgentContainerImage {
  const contextPath = NodePath.join(input.imagesDirectory, input.directoryName);
  const id = AgentContainerImageId.make(`folder:${input.directoryName}`);
  const tag = NodeCrypto.createHash("sha256").update(contextPath).digest("hex").slice(0, 16);
  return {
    id,
    name: input.directoryName,
    source: "folder",
    contextPath,
    containerfilePath: NodePath.join(contextPath, "Containerfile"),
    imageReference: `localhost/t3code-agent-image:${tag}`,
  };
}

export async function listAgentContainerImages(
  imagesDirectory: string,
): Promise<ReadonlyArray<AgentContainerImage>> {
  await NodeFSP.mkdir(imagesDirectory, { recursive: true, mode: 0o700 });
  const entries = await NodeFSP.readdir(imagesDirectory, {
    withFileTypes: true,
  });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const image = folderImage({
          imagesDirectory,
          directoryName: entry.name,
        });
        const containerfilePath = NodePath.join(imagesDirectory, entry.name, "Containerfile");
        try {
          const containerfile = await NodeFSP.stat(containerfilePath);
          return containerfile.isFile() ? image : null;
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
          throw cause;
        }
      }),
  );
  return [
    {
      id: DEFAULT_AGENT_CONTAINER_IMAGE_ID,
      name: "T3 default",
      source: "builtin",
    },
    ...folders
      .filter((image): image is AgentContainerImage => image !== null)
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  ];
}
