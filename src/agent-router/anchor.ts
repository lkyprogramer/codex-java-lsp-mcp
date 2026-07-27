// input: Impact anchor coordinates plus JavaIndex facts.
// output: ResolvedAnchor with profile inference and symbol metadata.
// pos: Async anchor resolution for the AgentRouter impact pipeline.
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeRepoFile } from "../repo-layout.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import {
  anchorToSourceFacts,
  fallbackSourceFacts,
  type JavaSourceFacts
} from "../java-index/router-facts.js";
import type {
  ImpactAnchorInput,
  ImpactProfile,
  ResolvedAnchor,
  ResolvedImpactProfile
} from "../agent-types.js";

type ResolveAnchorInput = {
  readonly repoRoot: string;
  readonly javaIndex: RouterIndex;
  readonly input: ImpactAnchorInput;
  readonly requested: ImpactProfile;
  readonly id: string;
  readonly generation?: number;
};

export async function resolveAnchor(input: ResolveAnchorInput): Promise<ResolvedAnchor> {
  const absolutePath = normalizeRepoFile(input.repoRoot, input.input.file);
  const generation = input.generation ?? 0;
  let facts: JavaSourceFacts;
  let methodName: string | undefined;
  let kind = "Type";
  try {
    await input.javaIndex.ensureFresh([absolutePath], generation);
    const anchor = await input.javaIndex.queryAnchor(absolutePath, input.input.line, input.input.column);
    if (anchor) {
      facts = anchorToSourceFacts(input.repoRoot, anchor);
      methodName = anchor.method?.name;
      kind = anchor.symbolKind === "METHOD" || anchor.symbolKind === "CONSTRUCTOR"
        ? "Method"
        : anchor.type?.kind || facts.kind || "Type";
    } else {
      facts = await input.javaIndex.factsFor(absolutePath, generation);
      const method = await input.javaIndex.methodAt(absolutePath, input.input.line, generation);
      methodName = method?.name;
      kind = method ? "Method" : facts.kind || "Type";
    }
  } catch {
    // Degraded index: keep impact alive with file/token fallback.
    const token = tokenAtColumn(absolutePath, input.input.line, input.input.column);
    facts = fallbackSourceFacts(input.repoRoot, absolutePath, token);
    methodName = undefined;
    kind = "Type";
  }

  const symbolName = tokenAtColumn(absolutePath, input.input.line, input.input.column)
    || methodName
    || facts.typeName
    || path.basename(absolutePath, ".java");
  const profile = input.requested === "auto" ? inferProfile(facts, input.input.role) : input.requested;
  return {
    id: input.id,
    absolutePath,
    path: facts.path,
    module: facts.module,
    layer: facts.layer,
    sourceSet: facts.sourceSet,
    line: input.input.line,
    column: input.input.column,
    role: input.input.role,
    profile,
    symbolName,
    methodName,
    className: facts.typeName,
    factSource: facts.factSource,
    kind
  };
}

function inferProfile(facts: JavaSourceFacts, role?: string): ResolvedImpactProfile {
  const explicit = roleToProfile(role);
  if (explicit) {
    return explicit;
  }
  const scores = new Map<ResolvedImpactProfile, number>();
  for (const annotation of facts.annotations.map(simpleAnnotation)) {
    if (["RestController", "Controller"].includes(annotation)) addScore(scores, "controller", 100);
    if (annotation === "Service") addScore(scores, "service", 100);
    if (annotation === "Repository") addScore(scores, "repository", 100);
    if (annotation === "Mapper") addScore(scores, "mapper", 100);
    if (["Entity", "Table"].includes(annotation)) addScore(scores, "entity", 100);
  }
  const typeText = [...facts.implementsTypes, facts.extendsType || ""].join(" ");
  if (/(JpaRepository|CrudRepository|Repository)\b/.test(typeText)) addScore(scores, "repository", 80);
  if (/\bMapper\b/.test(typeText)) addScore(scores, "mapper", 80);
  if (/(Gateway|Client|Port)\b/.test(typeText) || facts.kind === "interface") addScore(scores, "port", 80);

  const pathHint = (facts.path || "").toLowerCase();
  const nameHint = facts.typeName || "";
  if (pathHint.includes("/interfaces/web/") || pathHint.includes("/controller/")) addScore(scores, "controller", 50);
  if (pathHint.includes("/parser/")) addScore(scores, "parser", 50);
  if (pathHint.includes("/listener/")) addScore(scores, "listener", 50);
  if (pathHint.includes("/job/")) addScore(scores, "job", 50);
  if (pathHint.includes("/repository/")) addScore(scores, "repository", 50);
  if (pathHint.includes("/mapper/")) addScore(scores, "mapper", 50);
  if (pathHint.includes("/entity/")) addScore(scores, "entity", 50);
  if (pathHint.includes("/dto/")) addScore(scores, "dto", 50);
  if (pathHint.includes("/vo/")) addScore(scores, "vo", 50);

  if (/Controller$/.test(nameHint)) addScore(scores, "controller", 35);
  if (/Parser$/.test(nameHint)) addScore(scores, "parser", 35);
  if (/(Listener|EventHandler|Consumer)$/.test(nameHint)) addScore(scores, "listener", 35);
  if (/(Job|Scheduler|Scheduled|Task)$/.test(nameHint)) addScore(scores, "job", 35);
  if (/Repository$/.test(nameHint)) addScore(scores, "repository", 35);
  if (/Mapper$/.test(nameHint)) addScore(scores, "mapper", 35);
  if (/(Entity|DO)$/.test(nameHint)) addScore(scores, "entity", 35);
  if (/(Gateway|Port|Client)$/.test(nameHint)) addScore(scores, "port", 35);
  if (/(Request|Response|View|DTO|Command|Result)$/.test(nameHint) || facts.kind === "record") addScore(scores, "dto", 35);
  if (/VO$|Vo$/.test(nameHint)) addScore(scores, "vo", 35);

  return bestProfile(scores) || "service";
}

function roleToProfile(role?: string): ResolvedImpactProfile | undefined {
  if (!role) {
    return undefined;
  }
  const normalized = role.toLowerCase();
  return profileTieOrder.find(profile => profile === normalized);
}

function simpleAnnotation(value: string): string {
  const trimmed = value.replace(/^@/, "");
  return trimmed.slice(trimmed.lastIndexOf(".") + 1);
}

function addScore(scores: Map<ResolvedImpactProfile, number>, profile: ResolvedImpactProfile, value: number): void {
  scores.set(profile, (scores.get(profile) || 0) + value);
}

const profileTieOrder: ResolvedImpactProfile[] = ["controller", "parser", "listener", "job", "repository", "mapper", "entity", "port", "dto", "vo", "service"];

function bestProfile(scores: Map<ResolvedImpactProfile, number>): ResolvedImpactProfile | undefined {
  let best: ResolvedImpactProfile | undefined;
  let bestScore = 0;
  for (const profile of profileTieOrder) {
    const score = scores.get(profile) || 0;
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  }
  return best;
}

function tokenAtColumn(file: string, lineNumber: number, column: number): string | undefined {
  try {
    const line = (readFileSync(file, "utf8").split(/\r?\n/)[lineNumber - 1] || "");
    const index = Math.max(0, column - 1);
    const left = line.slice(0, index + 1).match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] || "";
    const right = line.slice(index + 1).match(/^[A-Za-z0-9_]*/)?.[0] || "";
    return left || right ? `${left}${right}` : undefined;
  } catch {
    return undefined;
  }
}
