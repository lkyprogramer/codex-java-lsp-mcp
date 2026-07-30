// input: A method/type's resolved FrameworkAnnotation list (mapping annotation argumentsText is raw,
//         un-evaluated source text - Slice A/B resolve FQNs but never evaluate expressions).
// output: SpringEndpointFact per plan Step 7 - conservative literal extraction only.
// pos: Task 27 Slice D, second commit. A method whose mapping annotation argument is not a plain
//      string/array-of-strings literal (a constant reference, a concatenation, a SpEL expression) is
//      real Spring usage this cannot evaluate - `paths: []` records "this is an endpoint, path unknown"
//      rather than guessing, matching the plan's explicit "unknown expression remains paths: []" rule.
import type { FrameworkAnnotation } from "../../java-index/framework-index-view.js";
import { SPRING_MAPPING_ANNOTATIONS, SPRING_REQUEST_MAPPING_FQN } from "./spring-annotations.js";

export type SpringEndpointFact = {
  methodId: string;
  httpMethods: string[];
  paths: string[];
};

type SpringMapping = { httpMethods: string[]; paths: string[] };

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;
const NAMED_VALUE_OR_PATH = /(?:^|,)\s*(?:value|path)\s*=\s*("(?:[^"\\]|\\.)*"|\{[^{}]*\})/;
const HAS_NAMED_ARGUMENT = /^[A-Za-z_]\w*\s*=/;
const REQUEST_METHOD_CONSTANT = /RequestMethod\.(\w+)/g;

function stringLiteralsIn(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].map(m => m[1]!.replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
}

/**
 * `("/orders")` and `({"/x", "/y"})` are positional; `(value = "/z", method = ...)` is named. Any other
 * shape (a constant reference, string concatenation, no value/path argument at all) yields [] rather
 * than a guess - this is the one place the plan's "conservative" instruction is load-bearing.
 */
export function pathsFromArgumentsText(argumentsText: string | undefined): string[] {
  if (!argumentsText) return [];
  const inner = argumentsText.slice(1, -1).trim();
  if (!inner) return [];
  const named = NAMED_VALUE_OR_PATH.exec(inner);
  if (named) return stringLiteralsIn(named[1]!);
  if (HAS_NAMED_ARGUMENT.test(inner)) return [];
  return stringLiteralsIn(inner);
}

/** Only the `RequestMethod.GET`-shaped enum-qualified form is recognized - a bare `GET` via static import is left undetected rather than guessed. */
export function httpMethodsFromArgumentsText(argumentsText: string | undefined): string[] {
  if (!argumentsText) return [];
  return [...argumentsText.matchAll(REQUEST_METHOD_CONSTANT)].map(m => m[1]!);
}

/** The first recognized mapping annotation on this annotation list, or undefined if none is present - "this declaration is not a Spring endpoint" is a real, common case. */
export function mappingOf(annotations: readonly FrameworkAnnotation[]): SpringMapping | undefined {
  for (const annotation of annotations) {
    if (!annotation.resolvedFqn) continue;
    const verb = SPRING_MAPPING_ANNOTATIONS.get(annotation.resolvedFqn);
    if (verb) return { httpMethods: [verb], paths: pathsFromArgumentsText(annotation.argumentsText) };
    if (annotation.resolvedFqn === SPRING_REQUEST_MAPPING_FQN) {
      return {
        httpMethods: httpMethodsFromArgumentsText(annotation.argumentsText),
        paths: pathsFromArgumentsText(annotation.argumentsText)
      };
    }
  }
  return undefined;
}

function joinPath(base: string, sub: string): string {
  if (!base) return sub;
  if (!sub) return base;
  return `${base.replace(/\/+$/, "")}/${sub.replace(/^\/+/, "")}`;
}

/** Composes a class-level `@RequestMapping` prefix (if any) with a method-level mapping - a bare method mapping (`classMapping` undefined) is used as-is. */
export function composeEndpointFact(methodId: string, classMapping: SpringMapping | undefined, methodMapping: SpringMapping): SpringEndpointFact {
  const basePaths = classMapping?.paths ?? [];
  const subPaths = methodMapping.paths;
  const paths = basePaths.length > 0 && subPaths.length > 0
    ? basePaths.flatMap(base => subPaths.map(sub => joinPath(base, sub)))
    : subPaths.length > 0 ? subPaths : basePaths;
  const httpMethods = methodMapping.httpMethods.length > 0 ? methodMapping.httpMethods : classMapping?.httpMethods ?? [];
  return { methodId, httpMethods, paths };
}
