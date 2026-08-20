// input: Method entity id plus conservative summary slots.
// output: §7.3 MethodSummary skeleton. N1 leaves call/dataflow/framework arrays empty.
// pos: N1 summary shape. N2a fills directCalls/virtualCalls; N2b fills flows.
import type { EdgeKind } from "./edge-kinds.js";

export type CallEdgeSummary = {
  toId: string;
  kind: Extract<EdgeKind, "CALLS_EXACT" | "CALLS_VIRTUAL" | "DISPATCHES_TO" | "CONSTRUCTS" | "METHOD_REFERENCE">;
};

export type ParameterFlow = {
  fromParameterIndex: number;
  toId: string;
};

export type ValueSource = {
  entityId: string;
  via: "parameter" | "field" | "call" | "local";
};

export type MethodSummary = {
  methodId: string;
  directCalls: CallEdgeSummary[];
  virtualCalls: CallEdgeSummary[];
  fieldsRead: string[];
  fieldsWritten: string[];
  parameterFlows: ParameterFlow[];
  returnSources: ValueSource[];
  thrownTypes: string[];
  persistenceTouches: string[];
  frameworkTouches: string[];
  lexicalFingerprint: number[];
};

export function emptyMethodSummary(methodId: string): MethodSummary {
  return {
    methodId,
    directCalls: [],
    virtualCalls: [],
    fieldsRead: [],
    fieldsWritten: [],
    parameterFlows: [],
    returnSources: [],
    thrownTypes: [],
    persistenceTouches: [],
    frameworkTouches: [],
    lexicalFingerprint: []
  };
}
