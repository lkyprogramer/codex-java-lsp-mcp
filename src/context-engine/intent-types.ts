// input: Agent-declared intent name or auto fallback.
// output: Frozen 9-intent enum from JIN §8.2.
// pos: N3-01. Adding an intent requires revising the phase handbook (0A.4 4b).

export const INTENTS = [
  "IMPLEMENTATION_CHANGE",
  "DOWNSTREAM_BEHAVIOR",
  "UPSTREAM_IMPACT",
  "CONTRACT_CHANGE",
  "PERSISTENCE_FLOW",
  "DATAFLOW_TRACE",
  "FRAMEWORK_WIRING",
  "TEST_PLANNING",
  "DIAGNOSTIC_ONLY"
] as const;

export type Intent = (typeof INTENTS)[number];

export function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}
