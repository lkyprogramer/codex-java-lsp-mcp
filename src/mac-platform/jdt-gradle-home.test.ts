import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { buildJdtlsEnv } from "../jdtls-lsp-io.js";
import { buildJavaSettings, pickJavaConfigurationSection } from "../jdtls-semantic-backend.js";

test("JDT environment and preferences select the same private Gradle home", () => {
  const original = process.env.JAVA_LSP_SERVICE_STATE_ROOT;
  process.env.JAVA_LSP_SERVICE_STATE_ROOT = path.join(process.env.TMPDIR!, "service-state");
  try {
    const expected = path.join(process.env.JAVA_LSP_SERVICE_STATE_ROOT, "jdt-gradle-home");
    const env = buildJdtlsEnv("/private/jdk");
    assert.equal(env.GRADLE_USER_HOME, expected);
    const settings = buildJavaSettings({ repoRoot: "/private/repo", buildSystem: "gradle",
      projectJdk: { status: "missing", source: "unknown", notes: [] } as never,
      generatedCode: { lombok: { detected: false, agentEnabled: false, status: "not_detected" },
        annotationProcessing: { detectedProcessors: [], enabled: false, source: "auto" }, generatedCodeSemantics: "ok" } as never });
    assert.equal(pickJavaConfigurationSection(settings, "java.import.gradle.user.home"), expected);
    assert.equal(env.JAVA_HOME, "/private/jdk");
  } finally {
    if (original === undefined) delete process.env.JAVA_LSP_SERVICE_STATE_ROOT;
    else process.env.JAVA_LSP_SERVICE_STATE_ROOT = original;
  }
});
