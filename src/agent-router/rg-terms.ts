import { existsSync } from "node:fs";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";
import type { ResolvedAnchor } from "../agent-types.js";
import { unique } from "./candidate-helpers.js";
import { actionTailRaw, capitalize, taskKeywordStems } from "./name-helpers.js";
import { broadSearchRoots } from "./rg-roots.js";

export function serviceTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Controller|AppService|Service|Assembler|Command|Request|Response|View|Result)`, safeSymbol(symbol)];
}

export function controllerTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Controller|AppService|Service|Assembler|Request|Response|Command|Result|Confirm|Summary)`, safeSymbol(symbol)];
}

export function taskKeywordTerms(keywords: string[]): string[] {
  return unique(taskKeywordStems(keywords).flatMap(({ stem, wordCount }) => {
    const escaped = literal(stem);
    const suffixes = wordCount > 1
      ? "Controller|AppService|Service|Assembler|Command|Request|Response|Result|DTO|View|Executor|Engine|Repository|Mapper|Entity|DO|Gateway|Port|Client|Config|Properties|Event|Listener|Handler|Consumer"
      : "Command|Request|Response|Result|DTO|View|Executor|Engine|Repository|Mapper|Entity|DO|Gateway|Port";
    const terms = [`${escaped}(${suffixes})`, `${escaped}(Request|Response)Assembler`, `Final${escaped}Result`];
    if (wordCount === 1) {
      terms.push(`${escaped}.*Assembler`);
    }
    return terms;
  }));
}

export function repositoryTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Repository|RepositoryImpl|Mapper|DO|Entity|AppService|Service|Task)`, safeSymbol(symbol), actionTail(symbol)];
}

export function parserTerms(base: string, stem: string, symbol: string): string[] {
  const domainStem = stem.replace(/Import$/, "");
  return [
    literal(base),
    `${literal(stem)}(Parser|Controller|AppService|Service|Assembler|Command|Result|DiffBuilder|ExcelParser|ParsedTemplate|Task|Artifact)`,
    domainStem !== stem ? `${literal(domainStem)}(ParsedTemplate|StudentDraft|TeacherDraft|GradeDraft|ClassDraft|PreviewItem|BindingDraft|BindingPreviewItem)` : "",
    safeSymbol(symbol)
  ];
}

export function portTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Gateway|Port|Client|AppService|Service|Command|Result|Config|Mapper)`, safeSymbol(symbol), actionTail(symbol)];
}

export function dtoTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Response|View|DTO|Assembler|Controller|AppService|Service)`, ...dtoFlowStemTerms(stem), safeSymbol(symbol), `${literal(symbol)}\\(`, `\\.${literal(symbol)}\\(`];
}

export function voTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(VO|Vo|View|DTO|Assembler|Controller|AppService|Service|Response)`, safeSymbol(symbol), `${literal(symbol)}\\(`, `\\.${literal(symbol)}\\(`];
}

export function entityTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Entity|DO|Mapper|Repository|RepositoryImpl|Service|AppService|Converter|Assembler)`, camelToSnake(stem), safeSymbol(symbol), actionTail(symbol)];
}

export function mapperTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Mapper|Entity|DO|Repository|RepositoryImpl|Service|AppService|Converter|Assembler)`, camelToSnake(stem), safeSymbol(symbol), actionTail(symbol)];
}

export function jobTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Job|Scheduler|Task|AppService|Service|Repository|Config|Properties)`, safeSymbol(symbol), actionTail(symbol)];
}

export function listenerTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Listener|Event|Publisher|Handler|Consumer|AppService|Service|Repository|Config)`, safeSymbol(symbol), actionTail(symbol)];
}

export function dtoUpstream(anchor: ResolvedAnchor, symbol: string, repoRoot: string, layoutContext?: LayoutContext): { terms: string[]; paths: string[] } {
  const root = symbol.replace(/Code$/, "");
  if (!root || root === symbol || root.length < 4) {
    return { terms: [], paths: [] };
  }
  const moduleName = root.charAt(0).toLowerCase() + root.slice(1);
  const detected = layoutContext?.sourceRoots
    .filter(item => item.sourceSet === "main" && item.module === moduleName)
    .map(item => item.relativePath) || [];
  const paths = detected.length > 0
    ? detected
    : existsSync(path.resolve(repoRoot, `modules/${moduleName}/src/main/java`)) ? [`modules/${moduleName}/src/main/java`] : broadSearchRoots(repoRoot, layoutContext);
  return {
    terms: [`${literal(capitalize(root))}(QueryAppService|View)`, `${literal(symbol)}\\(`, `\\.${literal(symbol)}\\(`],
    paths
  };
}

export function testTerms(anchor: ResolvedAnchor, base: string, stem: string, symbol: string): string[] {
  if (anchor.profile === "repository") {
    return repositoryTerms(base, stem, symbol);
  }
  if (anchor.profile === "parser") {
    return parserTerms(base, stem, symbol);
  }
  if (anchor.profile === "dto") {
    return dtoTerms(base, stem, symbol);
  }
  if (anchor.profile === "vo") {
    return voTerms(base, stem, symbol);
  }
  if (anchor.profile === "entity") {
    return entityTerms(base, stem, symbol);
  }
  if (anchor.profile === "mapper") {
    return mapperTerms(base, stem, symbol);
  }
  if (anchor.profile === "job") {
    return jobTerms(base, stem, symbol);
  }
  if (anchor.profile === "listener") {
    return listenerTerms(base, stem, symbol);
  }
  if (anchor.profile === "controller") {
    return controllerTerms(base, stem, symbol);
  }
  return [...portTerms(base, stem, symbol), `${literal(stem)}.*Test`];
}

export function sqlTerms(base: string, stem: string, symbol: string): string[] {
  return [camelToSnake(base), camelToSnake(stem), camelToSnake(symbol), actionTail(symbol) ? camelToSnake(actionTail(symbol)) : ""].map(literal);
}

function dtoFlowStemTerms(stem: string): string[] {
  const flowStem = stem.replace(/Student|Item|Detail|Entry/g, "");
  return flowStem && flowStem !== stem && flowStem.length >= 8
    ? [`${literal(flowStem)}(Controller|AppService|QueryAppService|Service|Assembler|Response|View|DTO)`]
    : [];
}

function safeSymbol(symbol: string): string {
  return isNoisySymbol(symbol) ? "" : literal(symbol);
}

function actionTail(symbol: string): string {
  const tail = actionTailRaw(symbol);
  return tail ? literal(tail) : "";
}

function isNoisySymbol(value: string): boolean {
  return value.length < 5 || new Set(["parse", "confirm", "get", "list", "page", "save", "update", "delete", "create", "find", "load", "query", "execute", "handle", "process", "apply", "build"]).has(value);
}

function literal(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
