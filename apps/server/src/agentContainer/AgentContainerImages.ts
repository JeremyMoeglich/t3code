// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { AgentContainerImageId, type AgentContainerImageDefinition } from "@t3tools/contracts";

const OCI_ARCHIVE_EXTENSION = ".tar";

export interface AgentContainerImage extends AgentContainerImageDefinition {
  readonly contextPath?: string;
  readonly containerfilePath?: string;
  readonly ociArchivePath?: string;
  readonly promotionPath?: string;
  readonly imageReference: string;
}

function logicalId(name: string) {
  // Keep existing selections valid as a Containerfile is promoted to OCI.
  return AgentContainerImageId.make(`folder:${name}`);
}

function imageReference(value: string) {
  const tag = NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `localhost/t3code-agent-image:${tag}`;
}

export function ociImageReference(
  archivePath: string,
  metadata: Pick<Awaited<ReturnType<typeof NodeFSP.stat>>, "mtimeMs" | "size">,
) {
  return imageReference(`${archivePath}\0${metadata.size}\0${metadata.mtimeMs}`);
}

function containerfileImage(input: {
  readonly containerfilesDirectory: string;
  readonly ociDirectory: string;
  readonly name: string;
}): AgentContainerImage {
  const contextPath = NodePath.join(input.containerfilesDirectory, input.name);
  return {
    id: logicalId(input.name),
    name: input.name,
    source: "containerfile",
    contextPath,
    containerfilePath: NodePath.join(contextPath, "Containerfile"),
    promotionPath: NodePath.join(input.ociDirectory, `${input.name}${OCI_ARCHIVE_EXTENSION}`),
    imageReference: imageReference(contextPath),
  };
}

function ociImage(input: {
  readonly archivePath: string;
  readonly name: string;
  readonly metadata: Pick<Awaited<ReturnType<typeof NodeFSP.stat>>, "mtimeMs" | "size">;
}): AgentContainerImage {
  return {
    id: logicalId(input.name),
    name: input.name,
    source: "oci",
    ociArchivePath: input.archivePath,
    imageReference: ociImageReference(input.archivePath, input.metadata),
  };
}

export async function listAgentContainerImages(
  imagesDirectory: string,
): Promise<ReadonlyArray<AgentContainerImage>> {
  const ociDirectory = NodePath.join(imagesDirectory, "oci");
  const containerfilesDirectory = NodePath.join(imagesDirectory, "containerfiles");
  await Promise.all(
    [imagesDirectory, ociDirectory, containerfilesDirectory].map((directory) =>
      NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );

  const [ociEntries, containerfileEntries] = await Promise.all([
    NodeFSP.readdir(ociDirectory, { withFileTypes: true }),
    NodeFSP.readdir(containerfilesDirectory, { withFileTypes: true }),
  ]);
  const images = new Map<string, AgentContainerImage>();

  await Promise.all(
    ociEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(OCI_ARCHIVE_EXTENSION))
      .map(async (entry) => {
        const name = entry.name.slice(0, -OCI_ARCHIVE_EXTENSION.length);
        if (!name) return;
        const archivePath = NodePath.join(ociDirectory, entry.name);
        const metadata = await NodeFSP.stat(archivePath);
        images.set(name, ociImage({ archivePath, name, metadata }));
      }),
  );

  await Promise.all(
    containerfileEntries
      .filter((entry) => entry.isDirectory() && !images.has(entry.name))
      .map(async (entry) => {
        const image = containerfileImage({
          containerfilesDirectory,
          ociDirectory,
          name: entry.name,
        });
        try {
          const metadata = await NodeFSP.stat(image.containerfilePath!);
          if (metadata.isFile()) images.set(entry.name, image);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
          throw cause;
        }
      }),
  );

  return [...images.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}
