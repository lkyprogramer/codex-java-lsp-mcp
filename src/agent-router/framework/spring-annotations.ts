// input: FrameworkAnnotation[]/FrameworkTypeRef from FrameworkIndexView's already-resolved facts.
// output: Spring's annotation FQN vocabulary and membership helpers.
// pos: Task 27 Slice D. No FQN resolution happens here - Slice A/B already resolved
//      ANNOTATED_WITH edges to a plain resolvedFqn string (undefined for ambiguous/unimported,
//      per the resolver's existing "no guessing" contract); this module only recognizes names.
import type { FrameworkAnnotation } from "../../java-index/framework-index-view.js";

export const SPRING_STEREOTYPE_ANNOTATIONS: ReadonlySet<string> = new Set([
  "org.springframework.stereotype.Component",
  "org.springframework.stereotype.Service",
  "org.springframework.stereotype.Repository",
  "org.springframework.stereotype.Controller",
  "org.springframework.web.bind.annotation.RestController"
]);

export const SPRING_MAPPING_ANNOTATIONS: ReadonlyMap<string, string> = new Map([
  ["org.springframework.web.bind.annotation.GetMapping", "GET"],
  ["org.springframework.web.bind.annotation.PostMapping", "POST"],
  ["org.springframework.web.bind.annotation.PutMapping", "PUT"],
  ["org.springframework.web.bind.annotation.DeleteMapping", "DELETE"],
  ["org.springframework.web.bind.annotation.PatchMapping", "PATCH"]
]);

export const SPRING_REQUEST_MAPPING_FQN = "org.springframework.web.bind.annotation.RequestMapping";
export const SPRING_REQUEST_BODY_FQN = "org.springframework.web.bind.annotation.RequestBody";
export const SPRING_EVENT_LISTENER_FQN = "org.springframework.context.event.EventListener";
export const SPRING_BEAN_FQN = "org.springframework.context.annotation.Bean";
export const SPRING_TRANSACTIONAL_FQN = "org.springframework.transaction.annotation.Transactional";
export const SPRING_AUTOWIRED_FQN = "org.springframework.beans.factory.annotation.Autowired";

export const SPRING_ANNOTATIONS: ReadonlySet<string> = new Set([
  ...SPRING_STEREOTYPE_ANNOTATIONS,
  ...SPRING_MAPPING_ANNOTATIONS.keys(),
  SPRING_REQUEST_MAPPING_FQN,
  SPRING_REQUEST_BODY_FQN,
  SPRING_EVENT_LISTENER_FQN,
  SPRING_BEAN_FQN,
  SPRING_TRANSACTIONAL_FQN,
  SPRING_AUTOWIRED_FQN
]);

export function findAnnotation(
  annotations: readonly FrameworkAnnotation[],
  fqn: string
): FrameworkAnnotation | undefined {
  return annotations.find(a => a.resolvedFqn === fqn);
}

export function hasAnnotation(annotations: readonly FrameworkAnnotation[], fqn: string): boolean {
  return findAnnotation(annotations, fqn) !== undefined;
}

export function isStereotype(annotations: readonly FrameworkAnnotation[]): boolean {
  return annotations.some(a => a.resolvedFqn !== undefined && SPRING_STEREOTYPE_ANNOTATIONS.has(a.resolvedFqn));
}

/** Any resolved annotation FQN under org.springframework - used by isActive()'s per-anchor check, not restricted to SPRING_ANNOTATIONS' initial recognized set. */
export function hasAnySpringAnnotation(annotations: readonly FrameworkAnnotation[]): boolean {
  return annotations.some(a => a.resolvedFqn?.startsWith("org.springframework.") ?? false);
}
