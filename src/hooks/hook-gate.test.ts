import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("hook advice tells enabled projects to start a stopped LSP server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-hook-enabled-"));
  await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>");
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({
    aliases: [
      { id: "demo", root, lspEnabled: true, layoutProfile: "generic-java" }
    ]
  }));

  const result = spawnSync(process.execPath, ["dist/hooks/hook-gate.js"], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    env: { ...process.env, JAVA_LSP_PROJECTS_JSON: config },
    input: JSON.stringify({ cwd: root, prompt: "排查 Java service 调用链" }),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const advice = payload.hookSpecificOutput.additionalContext;
  assert.match(advice, /不能只报告 LSP server 未启动/);
  assert.match(advice, /start:false/);
  assert.match(advice, /started=false/);
  assert.match(advice, /start:true/);
});
