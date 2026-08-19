// input: Shipped ImpactCostV6 after withConvergedCostV6, plus optional step extras.
// output: RetrievalCostVectorV1 whose bytes rebuild estimatedTokens without a λ scalar.
// pos: V5R Phase 3. Diagnostic-only vector. TaskSuccess stays UNMEASURED without authorization.
import type { ImpactCostV6, RetrievalCostVectorV1 } from "../../agent-types.js";

export const BYTES_PER_TOKEN = 4;

export type LambdaCalibrationStatus = "CALIBRATED_OFFLINE" | "BLOCKED_EXTERNAL" | "CALIBRATED_LIVE";

export type { RetrievalCostVectorV1 };

export type CostStepExtras = {
  toolCalls?: number;
  sourceReadCalls?: number;
  serviceMs?: number;
  additionalWireBytes?: number;
  additionalSourceBytes?: number;
  blockingMisses?: number;
};

export function reconstructEstimatedTokens(wireBytes: number, plannedSourceBytes: number): number {
  return Math.ceil((nonNegative(wireBytes) + nonNegative(plannedSourceBytes)) / BYTES_PER_TOKEN);
}

export function tokensProxyFromBytes(bytes: number): number {
  return Math.ceil(nonNegative(bytes) / BYTES_PER_TOKEN);
}

export function retrievalCostFromV6(cost: ImpactCostV6, extras: CostStepExtras = {}): RetrievalCostVectorV1 {
  const wireBytes = nonNegative(cost.resultBytes);
  const plannedSourceBytes = nonNegative(cost.readBytes);
  const additionalWireBytes = nonNegative(extras.additionalWireBytes ?? 0);
  const additionalSourceBytes = nonNegative(extras.additionalSourceBytes ?? 0);
  const serviceMs = nonNegative(extras.serviceMs ?? 0);
  return {
    wireBytes,
    wireTokensProxy: cost.wireTokensProxy ?? tokensProxyFromBytes(wireBytes),
    plannedSourceBytes,
    plannedSourceTokensProxy: cost.plannedSourceTokensProxy ?? tokensProxyFromBytes(plannedSourceBytes),
    additionalWireBytes,
    additionalWireTokensProxy: tokensProxyFromBytes(additionalWireBytes),
    additionalSourceBytes,
    additionalSourceTokensProxy: tokensProxyFromBytes(additionalSourceBytes),
    toolCalls: extras.toolCalls === undefined ? 1 : nonNegative(extras.toolCalls),
    sourceReadCalls: nonNegative(extras.sourceReadCalls ?? 0),
    serviceMs,
    cumulativeServiceMs: serviceMs,
    tokenEstimator: cost.tokenEstimator ?? "BYTE_DIV_4",
    ...(extras.blockingMisses === undefined ? {} : { blockingMisses: nonNegative(extras.blockingMisses) })
  };
}

export function accumulateCostSteps(steps: readonly RetrievalCostVectorV1[]): RetrievalCostVectorV1 {
  const empty = retrievalCostFromV6({
    resultBytes: 0,
    readBytes: 0,
    estimatedTokens: 0,
    suppressedRawBytes: 0,
    tokenEstimator: "BYTE_DIV_4"
  }, { toolCalls: 0, sourceReadCalls: 0, serviceMs: 0 });
  return steps.reduce((cumulative, step) => ({
    wireBytes: cumulative.wireBytes + step.wireBytes,
    wireTokensProxy: tokensProxyFromBytes(cumulative.wireBytes + step.wireBytes),
    plannedSourceBytes: cumulative.plannedSourceBytes + step.plannedSourceBytes,
    plannedSourceTokensProxy: tokensProxyFromBytes(cumulative.plannedSourceBytes + step.plannedSourceBytes),
    additionalWireBytes: cumulative.additionalWireBytes + step.additionalWireBytes,
    additionalWireTokensProxy: tokensProxyFromBytes(cumulative.additionalWireBytes + step.additionalWireBytes),
    additionalSourceBytes: cumulative.additionalSourceBytes + step.additionalSourceBytes,
    additionalSourceTokensProxy: tokensProxyFromBytes(cumulative.additionalSourceBytes + step.additionalSourceBytes),
    toolCalls: cumulative.toolCalls + step.toolCalls,
    sourceReadCalls: cumulative.sourceReadCalls + step.sourceReadCalls,
    serviceMs: step.serviceMs,
    cumulativeServiceMs: cumulative.cumulativeServiceMs + step.serviceMs,
    tokenEstimator: step.tokenEstimator,
    ...(step.modelId ? { modelId: step.modelId } : {}),
    ...(cumulative.blockingMisses === undefined && step.blockingMisses === undefined
      ? {}
      : { blockingMisses: (cumulative.blockingMisses ?? 0) + (step.blockingMisses ?? 0) })
  }), { ...empty, toolCalls: 0 });
}

export function lambdaCalibration(env: NodeJS.ProcessEnv = process.env): {
  status: LambdaCalibrationStatus;
  scalarAllowed: false;
  taskSuccess: "UNMEASURED";
} {
  const authorized = env.JAVA_LSP_AUTHORIZE_EXTERNAL === "1"
    && Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.JAVA_LSP_AGENT_API_KEY);
  return {
    status: authorized ? "BLOCKED_EXTERNAL" : "CALIBRATED_OFFLINE",
    scalarAllowed: false,
    taskSuccess: "UNMEASURED"
  };
}

export function refuseSyntheticScalar(reason = "λ is uncalibrated; compare cost-vector fields only"): never {
  throw new Error(reason);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
