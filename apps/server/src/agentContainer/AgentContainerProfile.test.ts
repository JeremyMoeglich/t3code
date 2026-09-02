// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { resolveAgentContainerProfile } from "./AgentContainerProfile.ts";

it("shares default package and tool resources across containers", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-container-profile-"));
  try {
    const projectPath = NodePath.join(root, "project");
    const projectResourceRoot = NodePath.join(root, "worktrees", ".t3-container-resources");
    await NodeFSP.mkdir(projectPath);
    const profile = await resolveAgentContainerProfile({
      stateDir: NodePath.join(root, "state"),
      projectPath,
      projectResourceRoot,
      defaultImage: "example/default:latest",
    });
    assert.equal(profile.image, "example/default:latest");
    assert.equal(profile.resources.length, 2);
    assert.equal(
      profile.environment.pnpm_config_store_dir,
      "/t3/worktrees/.t3-container-resources/package-cache/pnpm",
    );
    assert.equal(profile.environment.pnpm_config_package_import_method, "auto");
    assert.include(profile.environment.PATH, "/t3/tools/bin");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("merges generic global and project resource descriptors", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-container-profile-"));
  try {
    const stateDir = NodePath.join(root, "state");
    const projectPath = NodePath.join(root, "project");
    const projectResourceRoot = NodePath.join(root, "worktrees", ".t3-container-resources");
    await NodeFSP.mkdir(NodePath.join(projectPath, ".t3code"), { recursive: true });
    await NodeFSP.mkdir(stateDir, { recursive: true });
    const hostCompilerCache = NodePath.join(root, "host-compiler-cache");
    await NodeFSP.writeFile(
      NodePath.join(stateDir, "agent-container-profile.json"),
      JSON.stringify({
        image: "example/tools:global",
        resources: [
          {
            id: "compiler-cache",
            source: hostCompilerCache,
            target: "/t3/compiler-cache",
            sharing: "global",
            environment: { CCACHE_DIR: "/t3/compiler-cache" },
          },
        ],
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(projectPath, ".t3code", "container.json"),
      JSON.stringify({
        image: "example/tools:project",
        resources: [
          {
            id: "build-output",
            target: "/t3/build-output",
            sharing: "project",
          },
        ],
        environment: { PROJECT_TOOL_MODE: "debug" },
      }),
    );
    const profile = await resolveAgentContainerProfile({
      stateDir,
      projectPath,
      projectResourceRoot,
      defaultImage: "example/default:latest",
    });
    assert.equal(profile.image, "example/tools:project");
    assert.equal(profile.environment.CCACHE_DIR, "/t3/compiler-cache");
    assert.equal(profile.environment.PROJECT_TOOL_MODE, "debug");
    const compilerCache = profile.resources.find((resource) => resource.id === "compiler-cache");
    const buildOutput = profile.resources.find((resource) => resource.id === "build-output");
    assert.equal(compilerCache?.source, hostCompilerCache);
    assert.include(buildOutput?.source ?? "", projectResourceRoot);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("does not let a repository profile expose arbitrary host paths", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-container-profile-"));
  try {
    const projectPath = NodePath.join(root, "project");
    await NodeFSP.mkdir(NodePath.join(projectPath, ".t3code"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(projectPath, ".t3code", "container.json"),
      JSON.stringify({
        resources: [{ id: "home", source: "/home", target: "/t3/home" }],
      }),
    );
    let failure: unknown;
    try {
      await resolveAgentContainerProfile({
        stateDir: NodePath.join(root, "state"),
        projectPath,
        projectResourceRoot: NodePath.join(root, "worktrees", ".t3-container-resources"),
        defaultImage: "example/default:latest",
      });
    } catch (cause) {
      failure = cause;
    }
    assert.match(String(failure), /project profiles cannot expose host paths/);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
