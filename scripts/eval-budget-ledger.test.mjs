// Eval protocol v1.4: both arms see the same running ledger of
// the source they have received against the task budget, and the native read
// tool returns a bounded default window. Kit scoring is unchanged: the ledger
// counts exactly the retained source slices the kit counts as received.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runLiveAgentTask } from "./run-agent-trace-live.mjs";
import * as nativeTools from "./eval-native-tools.mjs";

const { buildToolSet } = nativeTools;

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "ledger-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/A.java"), Array.from({ length: 200 }, (_, i) => `// line ${i + 1}\n`).join(""));
  return root;
}

/** Two read calls in round 1, then an answer; records every request. */
function scriptedChat(requests) {
  return async request => {
    requests.push(structuredClone(request.messages));
    if (requests.length === 1) {
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              { id: "c1", function: { name: "read", arguments: JSON.stringify({ path: "src/A.java", startLine: 1, maxLines: 10 }) } },
              { id: "c2", function: { name: "read", arguments: JSON.stringify({ path: "src/A.java", startLine: 5, maxLines: 6 }) } }
            ]
          }
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      };
    }
    return { choices: [{ finish_reason: "stop", message: { content: "draft", tool_calls: [{ id: "submit", type: "function", function: { name: "submit_answer", arguments: '{"ok":true}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  };
}

async function run({ arm = "old", sourceBudget } = {}) {
  const root = repo();
  try {
    const toolSet = buildToolSet("control", "qa", { candidateRoot: root });
    const requests = [];
    await runLiveAgentTask({
      task: { taskId: "t", taskText: "read A", projectId: "p", requiredContextFiles: [], anchor: { file: "src/A.java", line: 1, column: 1 } },
      arm,
      tools: toolSet.tools,
      systemPrompt: "s",
      submission: { answerKeys: { ok: "boolean" } },
      chat: scriptedChat(requests),
      invoke: (name, args) => toolSet.invoke(name, args),
      ...(sourceBudget ? { sourceBudget } : {})
    });
    return requests;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const remainingOf = message => {
  const match = /remainingLines=(\d+), remainingBytes=(\d+)/.exec(message.content);
  assert.ok(match, "ledger exposes both remaining limits");
  return { lines: Number(match[1]), bytes: Number(match[2]), exhausted: /Source budget exhausted:/.test(message.content) };
};

const ledgerOf = messages => messages.filter(message => message.role === "user" && /^Source budget:/.test(message.content ?? ""));

test("after each tool round the model sees received lines/bytes against the task budget", async () => {
  const requests = await run({ sourceBudget: { max_lines: 160, max_bytes: 16000 } });
  const second = requests[1];
  const ledger = ledgerOf(second);
  assert.equal(ledger.length, 1, "one ledger line after the round's tool replies");
  // 10 + 6 lines; each "// line N\n" line, overlap counted twice as the kit does.
  const bytes = [...Array(10).keys()].map(i => `// line ${i + 1}\n`.length).reduce((a, b) => a + b, 0)
    + [...Array(6).keys()].map(i => `// line ${i + 5}\n`.length).reduce((a, b) => a + b, 0);
  assert.deepEqual(remainingOf(ledger[0]), { lines: 144, bytes: 16000 - bytes, exhausted: false });
  const index = second.indexOf(ledger[0]);
  assert.deepEqual(second.slice(index - 2, index).map(message => message.role), ["tool", "tool"], "after every tool reply of the round");
});

test("the ledger is arm-independent and absent without a budget", async () => {
  const budget = { max_lines: 160, max_bytes: 16000 };
  const [a, b] = [await run({ arm: "old", sourceBudget: budget }), await run({ arm: "jin", sourceBudget: budget })];
  assert.deepEqual(ledgerOf(a[1]).map(m => m.content), ledgerOf(b[1]).map(m => m.content));
  assert.equal(ledgerOf((await run())[1]).length, 0);
});

test("read without maxLines returns a bounded default window", async () => {
  const root = repo();
  try {
    const toolSet = buildToolSet("control", "qa", { candidateRoot: root });
    const result = await toolSet.invoke("read", { path: "src/A.java" });
    assert.equal(nativeTools.DEFAULT_READ_LINES, 80);
    assert.equal(result.endLine - result.startLine + 1, 80);
    const explicit = await toolSet.invoke("read", { path: "src/A.java", maxLines: 150 });
    assert.equal(explicit.endLine, 150, "an explicit window is honoured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("ledger explicitly signals exhaustion when either remaining source budget is zero", async () => {
  const bytes = [...Array(10).keys()].map(i => `// line ${i + 1}\n`.length).reduce((a, b) => a + b, 0)
    + [...Array(6).keys()].map(i => `// line ${i + 5}\n`.length).reduce((a, b) => a + b, 0);
  for (const sourceBudget of [{ max_lines: 16, max_bytes: 16000 }, { max_lines: 160, max_bytes: bytes }]) {
    const requests = await run({ sourceBudget });
    const ledger = ledgerOf(requests[1]);
    assert.equal(ledger.length, 1);
    assert.deepEqual(remainingOf(ledger[0]), { lines: sourceBudget.max_lines - 16, bytes: sourceBudget.max_bytes - bytes, exhausted: true });
  }
});
