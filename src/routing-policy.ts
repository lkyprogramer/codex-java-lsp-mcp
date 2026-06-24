// input: Router evidence context and built-in scoring policy.
// output: Candidate base score with traceable legacy rule ids.
// pos: Internal routing policy layer; no public per-repo DSL.
import type { ImpactOptions, ResolvedAnchor, ResolvedImpactProfile } from "./agent-types.js";
import type { PathContext } from "./repo-layout.js";

export type Confidence = "high" | "medium" | "low";
export type ScoreCategory = "java" | "protocol" | "persistence" | "config" | "tests" | "semantic" | "nonJava";

export type ScoreRule = {
  id: string;
  when: {
    category?: ScoreCategory | ScoreCategory[];
    profile?: ResolvedImpactProfile | ResolvedImpactProfile[];
    sourceSet?: string | string[];
    layer?: string | string[];
    pathRegex?: RegExp;
    sameFile?: boolean;
    sameModule?: boolean;
    focusModule?: boolean;
    taskKeyword?: boolean;
    moduleEquals?: string;
  };
  delta: number;
  reason: string;
};

export type RoutingPolicy = {
  id: "lishuedu-legacy" | "generic-java" | "maven-reactor" | "ddd-gradle";
  categoryBase: Record<ScoreCategory, number>;
  confidenceDeltas: Record<Confidence, number>;
  scoreRules: ScoreRule[];
};

export const legacyRoutingPolicy: RoutingPolicy = {
  id: "lishuedu-legacy",
  categoryBase: {
    persistence: 70,
    protocol: 64,
    java: 56,
    semantic: 80,
    tests: 24,
    config: 18,
    nonJava: 18
  },
  confidenceDeltas: { high: 0, medium: 0, low: 0 },
  scoreRules: [
    rule("structure.same-file", { sameFile: true }, 180, "same file as anchor"),
    rule("structure.same-module", { sameModule: true }, 28, "same module as anchor"),
    rule("structure.main-source", { sourceSet: "main" }, 14, "main source set"),
    rule("structure.interface-application-layer", { layer: ["interfaces", "application"] }, 12, "interfaces/application layer"),
    rule("profile.controller.interfaces", { profile: "controller", layer: "interfaces" }, 35, "controller interface layer"),
    rule("profile.repository.infrastructure", { profile: "repository", pathRegex: /(\/infrastructure\/|\/db\/migration\/)/ }, 35, "repository infrastructure evidence"),
    rule("profile.entity.family", { profile: "entity", pathRegex: /(\/entity\/|Entity|DO|Mapper|Repository|db\/migration)/ }, 34, "entity family evidence"),
    rule("profile.mapper.family", { profile: "mapper", pathRegex: /(\/mapper\/|Mapper|Entity|DO|Repository|\.xml$|db\/migration)/ }, 36, "mapper family evidence"),
    rule("profile.job.family", { profile: "job", pathRegex: /(Job|Scheduler|Schedule|Task|Config|AppService|Service|Repository)/ }, 32, "job family evidence"),
    rule("profile.listener.family", { profile: "listener", pathRegex: /(Listener|Event|Publisher|Handler|Consumer|AppService|Service|Repository)/ }, 32, "listener family evidence"),
    rule("profile.parser.family", { profile: "parser", pathRegex: /Parser|ParsedTemplate|DiffBuilder|Draft|PreviewItem/ }, 38, "parser family evidence"),
    rule("profile.parser.persistence-penalty", { profile: "parser", pathRegex: /\/persistence\/|Repository|Mapper|DO|Task(File|Status|Repository|Mapper|DO)?/ }, -70, "parser persistence penalty"),
    rule("profile.parser.tests", { profile: "parser", sourceSet: "test", pathRegex: /ExcelParserTest|DiffBuilderTest/ }, 90, "parser targeted tests"),
    rule("profile.port.family", { profile: "port", pathRegex: /Gateway|Config|SignedUrl|AppService|Report/ }, 30, "port family evidence"),
    rule("profile.dto.family", { profile: "dto", pathRegex: /Assembler|Controller|QueryAppService|ProductView|ParentBenefit|ItemView/ }, 32, "dto family evidence"),
    rule("profile.vo.family", { profile: "vo", pathRegex: /VO|Vo|View|Assembler|Controller|AppService|Service/ }, 30, "vo family evidence"),
    rule("profile.dto.tests", { profile: "dto", sourceSet: "test", pathRegex: /ParentBenefitQueryAppServiceTest|BenefitEntitlementAssemblerTest/ }, 90, "dto targeted tests"),
    rule("options.focus-module", { focusModule: true }, 18, "focus module"),
    rule("options.task-keyword", { taskKeyword: true }, 20, "task keyword"),
    rule("structure.common-penalty", { moduleEquals: "common" }, -20, "common module penalty")
  ]
};

export function scoreWithPolicy(policy: RoutingPolicy, category: ScoreCategory, context: PathContext, anchor: ResolvedAnchor, options: ImpactOptions): number {
  let score = policy.categoryBase[category] ?? 18;
  for (const item of policy.scoreRules) {
    if (matchesRule(item, category, context, anchor, options)) {
      score += item.delta;
    }
  }
  return Math.max(1, score);
}

function matchesRule(rule: ScoreRule, category: ScoreCategory, context: PathContext, anchor: ResolvedAnchor, options: ImpactOptions): boolean {
  const when = rule.when;
  if (when.category && !includes(when.category, category)) {
    return false;
  }
  if (when.profile && !includes(when.profile, anchor.profile)) {
    return false;
  }
  if (when.sourceSet && !includes(when.sourceSet, context.sourceSet || "")) {
    return false;
  }
  if (when.layer && !includes(when.layer, context.layer || "")) {
    return false;
  }
  if (when.pathRegex && !when.pathRegex.test(context.relativePath || "")) {
    return false;
  }
  if (when.sameFile && context.relativePath !== anchor.path) {
    return false;
  }
  if (when.sameModule && context.module !== anchor.module) {
    return false;
  }
  if (when.focusModule && (!context.module || !options.focusModules.includes(context.module))) {
    return false;
  }
  if (when.taskKeyword && (!context.relativePath || !matchesAny(context.relativePath, options.taskKeywords))) {
    return false;
  }
  if (when.moduleEquals && context.module !== when.moduleEquals) {
    return false;
  }
  return true;
}

function rule(id: string, when: ScoreRule["when"], delta: number, reason: string): ScoreRule {
  return { id, when, delta, reason };
}

function includes<T extends string>(value: T | T[], item: T): boolean {
  return Array.isArray(value) ? value.includes(item) : value === item;
}

function matchesAny(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some(keyword => keyword.length > 0 && lower.includes(keyword.toLowerCase()));
}
