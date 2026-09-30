// input:  一个 chat 实现（fake 或真实 SDK 封装）+ 工具名 + 原始工具结果。
// output: 最后一跳 model tool message 的精确载荷（received）、chat 边界回执
//         （receipts，含 model-payload hash）、SOURCE_RECEIVED 原始事件。
// pos:    R01 wire 机制的单一驱动入口：离线反例用它验证 fake 往返；R12 必须
//         用真实 SDK transport 再跑同一驱动，两级证据分开记录。本工具本身
//         不调用任何模型，不产生网络流量。
import { runLiveAgentTask } from "./run-agent-trace-live.mjs";
import { createRecorder } from "./evaluate-java-task.mjs";

/**
 * Runs the real runLiveAgentTask loop with one injected tool result and a
 * chat implementation supplied by the caller, returning everything the
 * boundary audit needs. `chat` receives the exact request the loop would send
 * ({messages, tools, maxTokens}) and must return a completion-shaped object.
 */
export async function runEvalToolWire({ name, raw, chat, maxBytes, toolSchema, systemPrompt, taskText = "Return the source value.", maxRounds = 3 }) {
  const recorder = createRecorder();
  const observations = [];
  let callSeq = 0;
  let received;
  let finalChatRequest;
  const wrappedChat = async request => {
    callSeq += 1;
    finalChatRequest = { messages: request.messages, tools: request.tools, maxTokens: request.maxTokens };
    observations.push({
      chatCall: callSeq,
      toolMessages: (request.messages ?? []).filter(m => m.role === "tool").map(m => ({ tool_call_id: m.tool_call_id, content: m.content })),
      payloadHash: undefined
    });
    const completion = await chat(request);
    return completion;
  };
  const run = await runLiveAgentTask({
    task: { taskId: "sentinel", taskText, projectId: "fixture", anchor: { file: "A.java", line: 1, column: 1 }, requiredContextFiles: [] },
    systemPrompt: systemPrompt ?? "Use the supplied tools. Return JSON.",
    maxRounds,
    tools: toolSchema ? [toolSchema] : [{ type: "function", function: { name, parameters: { type: "object" } } }],
    invoke: async toolName => {
      recorder.recordToolResult({ callId: `c${callSeq}`, toolName, result: raw });
      return raw;
    },
    onChat: ({ messages, receipts, payloadHash }) => {
      // Keep the LAST capture: the final chat request is the one that carries
      // the tool results, which is exactly what "delivered to the model"
      // means at the wire boundary.
      received = {
        // Only the model-facing tool messages, exactly as serialized.
        toolMessages: (messages ?? []).filter(m => m.role === "tool").map(m => ({ tool_call_id: m.tool_call_id, content: m.content })),
        receipts,
        payloadHash
      };
      for (const receipt of receipts) {
        recorder.recordModelDelivery(receipt);
      }
    },
    chat: wrappedChat
  });
  return {
    run,
    // What the final chat request carried (null if no chat happened).
    received,
    finalChatRequest,
    observations,
    events: recorder.events(),
    sourceReceived: recorder.events().filter(e => e.type === "SOURCE_RECEIVED"),
    deliveries: recorder.events().filter(e => e.type === "MODEL_TOOL_DELIVERED")
  };
}

/** A deterministic fake chat: first call emits the one tool call, then a
 *  strict-JSON final answer. Wire-mechanism validation only - a PASS here
 *  never implies model effectiveness. */
export function fakeChat({ toolName = "read", argumentsJson = "{}", answer = '{"ok":true}' } = {}) {
  let step = 0;
  return async request => {
    step += 1;
    if (step === 1) {
      return {
        choices: [{
          message: { tool_calls: [{ id: "c1", type: "function", function: { name: toolName, arguments: argumentsJson } }] },
          finish_reason: "tool_calls"
        }]
      };
    }
    return { choices: [{ message: { content: answer }, finish_reason: "stop" }] };
  };
}