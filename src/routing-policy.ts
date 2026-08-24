// input: Repository identity and the optional compatibility override.
// output: One explicit evidence-family policy selection id.
// pos: Internal routing policy selector; final ranking lives in family-ranker.ts.
import path from "node:path";
import { genericFamilyRankPolicy, lishueduFamilyRankPolicy, type FamilyRankPolicy } from "./agent-router/family-ranker.js";

export type RoutingPolicy = {
  id: "lishuedu" | "generic-java";
};

export const lishueduPolicy: RoutingPolicy = { id: "lishuedu" };

export const genericJavaPolicy: RoutingPolicy = { id: "generic-java" };

export function resolveRoutingPolicy(repoRoot: string): RoutingPolicy {
  const override = process.env.JAVA_LSP_ROUTING_POLICY;
  // Keep the former override string as an input compatibility alias, but do
  // not let it reintroduce a third, obsolete policy identity downstream.
  if (override === "lishuedu" || override === "lishuedu-legacy") {
    return lishueduPolicy;
  }
  if (override === "generic-java") {
    return genericJavaPolicy;
  }
  return path.basename(repoRoot) === "lishuedu" ? lishueduPolicy : genericJavaPolicy;
}

export function resolveFamilyRankPolicy(policy: Pick<RoutingPolicy, "id">): FamilyRankPolicy {
  return policy.id === "lishuedu" ? lishueduFamilyRankPolicy : genericFamilyRankPolicy;
}
