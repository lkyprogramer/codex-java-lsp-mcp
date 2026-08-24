import assert from "node:assert/strict";
import test from "node:test";
import { extractStdioProjectJdkEnv, renderProjectJdkEnv } from "./extract-stdio-project-jdk-env.mjs";

test("only supported stdio project JDK overrides are migrated", () => {
  const config = {
    transport: {
      type: "stdio",
      command: "/runtime/run.sh",
      env: {
        JDTLS_BIN: "/opt/homebrew/bin/jdtls",
        JAVA_LSP_PROJECT_JAVA_HOME: "/Library/Java/global",
        JAVA_LSP_PROJECT_JAVA_HOME_APP_ONE: "/Library/Java/app-one",
        JAVA_LSP_PROJECT_JAVA_HOME_bad: "/Library/Java/ignored",
        JAVA_LSP_PROJECT_JAVA_HOME_APP_TWO: "/Library/Java/app-two"
      }
    }
  };
  assert.deepEqual([...extractStdioProjectJdkEnv(config)], [
    ["JAVA_LSP_PROJECT_JAVA_HOME", "/Library/Java/global"],
    ["JAVA_LSP_PROJECT_JAVA_HOME_APP_ONE", "/Library/Java/app-one"],
    ["JAVA_LSP_PROJECT_JAVA_HOME_APP_TWO", "/Library/Java/app-two"]
  ]);
  assert.equal(renderProjectJdkEnv(config), [
    "JAVA_LSP_PROJECT_JAVA_HOME\t/Library/Java/global",
    "JAVA_LSP_PROJECT_JAVA_HOME_APP_ONE\t/Library/Java/app-one",
    "JAVA_LSP_PROJECT_JAVA_HOME_APP_TWO\t/Library/Java/app-two"
  ].join("\n"));
});

test("non-stdio registrations and unsafe values cannot contribute daemon environment", () => {
  assert.deepEqual([...extractStdioProjectJdkEnv({ transport: { type: "streamable_http", env: {
    JAVA_LSP_PROJECT_JAVA_HOME_APP: "/Library/Java/app"
  } } })], []);
  assert.throws(() => extractStdioProjectJdkEnv({ transport: { type: "stdio", env: {
    JAVA_LSP_PROJECT_JAVA_HOME_APP: "/Library/Java/app\nmalicious"
  } } }), /Unsupported stdio project JDK/);
});
