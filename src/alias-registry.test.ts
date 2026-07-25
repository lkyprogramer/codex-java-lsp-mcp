import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AliasRegistry } from "./alias-registry.js";

function configPathFor(): { dir: string; configPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "alias-registry-"));
  return { dir, configPath: path.join(dir, "projects.json") };
}

function validConfig(id: string): string {
  return JSON.stringify({
    aliases: [{ id, root: path.join(tmpdir(), id), lspEnabled: false }]
  });
}

test("loads a valid config and exposes its aliases", async () => {
  const { configPath } = configPathFor();
  writeFileSync(configPath, validConfig("repo-a"));
  const registry = new AliasRegistry(configPath);
  await registry.reloadIfChanged();
  assert.equal(registry.aliases()[0].id, "repo-a");
  assert.equal(registry.status().lastReloadError, undefined);
});

test("a broken first load throws: there is no last-known-good to fall back to", async () => {
  const { configPath } = configPathFor();
  writeFileSync(configPath, "{broken");
  const registry = new AliasRegistry(configPath);
  await assert.rejects(() => registry.reloadIfChanged());
});

test("AliasRegistry retains last known good config when a reload is invalid JSON", async () => {
  const { configPath } = configPathFor();
  writeFileSync(configPath, validConfig("repo-a"));
  const registry = new AliasRegistry(configPath);
  await registry.reloadIfChanged();
  assert.equal(registry.aliases()[0].id, "repo-a");

  writeFileSync(configPath, "{broken");
  await registry.reloadIfChanged();

  assert.equal(registry.aliases()[0].id, "repo-a");
  assert.match(registry.status().lastReloadError ?? "", /JSON/);
});

test("AliasRegistry retains last known good config when a reload has a schema violation", async () => {
  const { configPath } = configPathFor();
  writeFileSync(configPath, validConfig("repo-a"));
  const registry = new AliasRegistry(configPath);
  await registry.reloadIfChanged();
  assert.equal(registry.aliases()[0].id, "repo-a");

  // Valid JSON, invalid shape: `root` must be absolute.
  writeFileSync(configPath, JSON.stringify({ aliases: [{ id: "repo-b", root: "relative/path" }] }));
  await registry.reloadIfChanged();

  assert.equal(registry.aliases()[0].id, "repo-a", "the last-known-good config survives a schema violation too");
  assert.ok(registry.status().lastReloadError, "the schema error is recorded");
});

test("deleting the config file clears aliases and any prior reload error", async () => {
  const { configPath } = configPathFor();
  writeFileSync(configPath, validConfig("repo-a"));
  const registry = new AliasRegistry(configPath);
  await registry.reloadIfChanged();

  writeFileSync(configPath, "{broken");
  await registry.reloadIfChanged();
  assert.ok(registry.status().lastReloadError);

  rmSync(configPath);
  await registry.reloadIfChanged();

  assert.deepEqual(registry.aliases(), []);
  assert.equal(registry.status().lastReloadError, undefined, "deletion is a valid state, not a lingering error");
});
