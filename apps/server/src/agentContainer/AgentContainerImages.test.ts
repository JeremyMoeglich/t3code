// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { listAgentContainerImages } from "./AgentContainerImages.ts";

it.effect("lists OCI archives first and lets them shadow equal-named Containerfiles", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-images-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const ociDirectory = NodePath.join(root, "oci");
    const containerfilesDirectory = NodePath.join(root, "containerfiles");
    yield* Effect.promise(() =>
      Promise.all([
        NodeFSP.mkdir(ociDirectory, { recursive: true }),
        NodeFSP.mkdir(NodePath.join(containerfilesDirectory, "source-only"), {
          recursive: true,
        }),
        NodeFSP.mkdir(NodePath.join(containerfilesDirectory, "shadowed"), {
          recursive: true,
        }),
      ]),
    );
    yield* Effect.promise(() =>
      Promise.all([
        NodeFSP.writeFile(NodePath.join(ociDirectory, "shadowed.tar"), "oci"),
        NodeFSP.writeFile(NodePath.join(ociDirectory, "archive-only.tar"), "oci"),
        NodeFSP.writeFile(
          NodePath.join(containerfilesDirectory, "source-only", "Containerfile"),
          "FROM scratch\n",
        ),
        NodeFSP.writeFile(
          NodePath.join(containerfilesDirectory, "shadowed", "Containerfile"),
          "FROM scratch\n",
        ),
      ]),
    );

    const images = yield* Effect.promise(() => listAgentContainerImages(root));

    assert.deepEqual(
      images.map(({ id, name, source }) => ({ id, name, source })),
      [
        { id: "folder:archive-only", name: "archive-only", source: "oci" },
        { id: "folder:shadowed", name: "shadowed", source: "oci" },
        { id: "folder:source-only", name: "source-only", source: "containerfile" },
      ],
    );
    assert.equal(
      images.find((image) => image.name === "source-only")?.promotionPath,
      NodePath.join(ociDirectory, "source-only.tar"),
    );
  }),
);
