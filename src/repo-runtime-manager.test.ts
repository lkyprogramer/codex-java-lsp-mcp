import assert from "node:assert/strict";
import test from "node:test";
import { RepoRuntimeManager, type ManagedToolContext } from "./repo-runtime-manager.js";
import type { ResolvedRepo } from "./repo-resolver.js";

test("RepoRuntimeManager evicts the oldest idle started runtime before starting another", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 100
  }, resolved => fakeContext(resolved, sessions));

  await manager.withContext({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  await manager.withContext({ repoRoot: "/repo-b" }, async context => {
    (context.session as unknown as FakeSession).started = true;
  }, { mayStartLsp: true });

  assert.equal(sessions.get("/repo-a")?.stops, 1);
  assert.equal(sessions.get("/repo-b")?.stops, 0);
});

test("RepoRuntimeManager fails fast when all active runtimes are in use", async () => {
  const sessions = new Map<string, FakeSession>();
  const manager = new RepoRuntimeManager(fakeResolver(), {
    maxActiveRepos: 1,
    idleTtlMs: 100000,
    requestTimeoutMs: 30
  }, resolved => fakeContext(resolved, sessions));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const firstEntered = new Promise<void>(resolve => {
    entered = resolve;
  });

  const first = manager.withContext({ repoRoot: "/repo-a" }, async context => {
    (context.session as unknown as FakeSession).started = true;
    entered();
    await held;
  }, { mayStartLsp: true });
  await firstEntered;

  await assert.rejects(
    () => manager.withContext({ repoRoot: "/repo-b" }, async context => {
      (context.session as unknown as FakeSession).started = true;
    }, { mayStartLsp: true }),
    /active limit is 1/
  );

  release();
  await first;
});

class FakeSession {
  started = false;
  stops = 0;

  status(): { started: boolean } {
    return { started: this.started };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.started = false;
  }
}

function fakeResolver(): { resolve(selector: { repoRoot?: string }): Promise<ResolvedRepo> } {
  return {
    async resolve(selector) {
      const repoRoot = selector.repoRoot || "/repo";
      return {
        repoRoot,
        repoHash: repoRoot.replace(/\W/g, ""),
        aliases: [],
        layoutProfile: "generic-java",
        lsp: {
          enabled: true,
          matchedBy: "direct-root",
          configuredRoot: repoRoot,
          effectiveRepoRoot: repoRoot
        }
      };
    }
  };
}

function fakeContext(resolved: ResolvedRepo, sessions: Map<string, FakeSession>): ManagedToolContext {
  const session = new FakeSession();
  sessions.set(resolved.repoRoot, session);
  return {
    repoRoot: resolved.repoRoot,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    session: session as never,
    sourceIndex: {} as never,
    router: {
      clearRgCache() {}
    } as never
  };
}
