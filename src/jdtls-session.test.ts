import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { filterGeneratedCodeDiagnostics, terminateJdtlsChild, type JdtlsChild } from "./jdtls-session.js";
import type { GeneratedCodeStatus } from "./generated-code.js";
import type { LspDiagnostic } from "./jdtls-session.js";

const lombokStatus: GeneratedCodeStatus = {
  lombok: {
    detected: true,
    agentEnabled: true,
    status: "enabled"
  },
  annotationProcessing: {
    detectedProcessors: ["lombok"],
    enabled: true,
    source: "auto"
  },
  generatedCodeSemantics: "ok"
};

test("filters only Lombok generated log unresolved diagnostics", () => {
  const source = [
    "package demo;",
    "",
    "import lombok.extern.slf4j.Slf4j;",
    "",
    "@Slf4j",
    "class Demo {",
    "  void run(User user) {",
    "    log.info(\"{}\", user.missing());",
    "  }",
    "}"
  ].join("\n");
  const diagnostics: LspDiagnostic[] = [
    diagnosticAt(8, 5, 8, "log cannot be resolved to a variable"),
    diagnosticAt(8, 20, 24, "The method missing() is undefined for the type User")
  ];

  const filtered = filterGeneratedCodeDiagnostics({ generatedCode: lombokStatus, source, diagnostics });

  assert.deepEqual(filtered.map(diagnostic => diagnostic.message), ["The method missing() is undefined for the type User"]);
});

test("JDT child termination waits for a graceful close", async () => {
  const child = new FakeJdtlsChild("sigterm");

  await terminateJdtlsChild(child as unknown as JdtlsChild, 5);

  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("JDT child termination escalates when SIGTERM does not close the process", async () => {
  const child = new FakeJdtlsChild("sigkill");

  await terminateJdtlsChild(child as unknown as JdtlsChild, 5);

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

class FakeJdtlsChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly closeOn: "sigterm" | "sigkill") {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    const closes = (signal === "SIGTERM" && this.closeOn === "sigterm")
      || (signal === "SIGKILL" && this.closeOn === "sigkill");
    if (closes) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

function diagnosticAt(line: number, start: number, end: number, message: string): LspDiagnostic {
  return {
    range: {
      start: { line: line - 1, character: start - 1 },
      end: { line: line - 1, character: end - 1 }
    },
    severity: 1,
    code: "compiler.err.cant.resolve",
    source: "Java",
    message
  };
}
