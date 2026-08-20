// input: Requested intent plus optional auto-fallback signals (profile/keywords/path).
// output: resolvedIntent and the obligation list. auto is fallback only; explicit intent wins.
// pos: N3-01. Signals never include scene ids.
import { INTENTS, isIntent, type Intent } from "./intent-types.js";
import { obligationsFor, type Obligation } from "./obligations.js";

export type IntentSignals = {
  profile?: string;
  taskText?: string;
  relativePath?: string;
};

export type CompiledIntent = {
  requested: string;
  resolvedIntent: Intent;
  obligations: Obligation[];
};

function inferIntent(signals: IntentSignals): Intent {
  const text = `${signals.profile ?? ""} ${signals.taskText ?? ""} ${signals.relativePath ?? ""}`.toLowerCase();
  if (/\b(mapper|mybatis|repository|template|jpa|entity|sql)\b/.test(text)) return "PERSISTENCE_FLOW";
  if (/\b(test|junit|assert)\b/.test(text)) return "TEST_PLANNING";
  if (/\b(inject|autowired|spring|eventlistener|bean)\b/.test(text)) return "FRAMEWORK_WIRING";
  if (/\b(caller|upstream|impact|who calls)\b/.test(text)) return "UPSTREAM_IMPACT";
  if (/\b(controller|api|endpoint|dto|request|response)\b/.test(text)) return "CONTRACT_CHANGE";
  if (/\b(flow|dataflow|source)\b/.test(text)) return "DATAFLOW_TRACE";
  if (/\b(diagnos|error|exception|bug)\b/.test(text)) return "DIAGNOSTIC_ONLY";
  if (/\b(downstream|callee|behavior)\b/.test(text)) return "DOWNSTREAM_BEHAVIOR";
  return "IMPLEMENTATION_CHANGE";
}

export function compileIntent(requested: string, signals: IntentSignals = {}): CompiledIntent {
  const resolvedIntent = requested === "auto" || !isIntent(requested) ? inferIntent(signals) : requested;
  return {
    requested,
    resolvedIntent,
    obligations: obligationsFor(resolvedIntent)
  };
}

export function allIntents(): Intent[] {
  return [...INTENTS];
}
