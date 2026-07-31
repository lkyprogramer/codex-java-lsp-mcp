// input: FrameworkAnnotation[]/FrameworkImport[] from FrameworkIndexView's already-resolved facts.
// output: JPA's annotation/repository-base FQN vocabulary and membership helpers.
// pos: Task 29 commit 3. Mirrors spring-annotations.ts's pattern (its own file, not a shared
//      import - each framework pack stays independently removable). Unlike Spring, JPA's
//      annotations live under two interchangeable packages (jakarta.persistence / the legacy
//      javax.persistence) - every FQN constant here is a pair, not a single string.
import type { FrameworkAnnotation, FrameworkImport } from "../../java-index/framework-index-view.js";

function bothPersistencePackages(simpleName: string): [string, string] {
  return [`jakarta.persistence.${simpleName}`, `javax.persistence.${simpleName}`];
}

export const JPA_ENTITY_FQNS = bothPersistencePackages("Entity");
const JPA_RELATION_SIMPLE_NAMES = ["ManyToOne", "OneToMany", "OneToOne", "ManyToMany"];
export const JPA_RELATION_FQNS = JPA_RELATION_SIMPLE_NAMES.flatMap(bothPersistencePackages);

export const JPA_ANNOTATIONS: ReadonlySet<string> = new Set([...JPA_ENTITY_FQNS, ...JPA_RELATION_FQNS]);

/** Spring Data repository base interfaces recognized as "this interface's first generic argument is a JPA entity, its second an id type". */
export const JPA_REPOSITORY_BASE_FQNS: ReadonlySet<string> = new Set([
  "org.springframework.data.jpa.repository.JpaRepository",
  "org.springframework.data.repository.CrudRepository",
  "org.springframework.data.repository.PagingAndSortingRepository"
]);

/**
 * Mirrors spring-annotations.ts's normalizeSpringAnnotations: a wildcard
 * import (`import jakarta.persistence.*;`, idiomatic for JPA entities) only
 * completes a *known* JPA annotation's resolvedFqn, and only once the
 * owning file's facts are COMPLETE - explicit/same-package resolution
 * already happened in the generic resolver.
 */
export function normalizeJpaAnnotations(
  annotations: readonly FrameworkAnnotation[],
  imports: readonly FrameworkImport[],
  coverage: "COMPLETE" | "PARTIAL" | "DEGRADED"
): FrameworkAnnotation[] {
  if (coverage !== "COMPLETE") return [...annotations];
  const explicitNames = new Set(imports.filter(imp => !imp.wildcard && !imp.static).map(imp => imp.qualifiedName));
  return annotations.map(annotation => {
    if (annotation.resolvedFqn) return annotation;
    const candidates = [...JPA_ANNOTATIONS].filter(fqn => {
      const dot = fqn.lastIndexOf(".");
      const simple = fqn.slice(dot + 1);
      const owner = fqn.slice(0, dot);
      return simple === annotation.name
        && imports.some(imp => !imp.static && imp.wildcard && imp.qualifiedName === owner)
        && ![...explicitNames].some(imported => imported.endsWith(`.${annotation.name}`) && imported !== fqn);
    });
    return candidates.length === 1 ? { ...annotation, resolvedFqn: candidates[0] } : annotation;
  });
}

export function hasAnnotation(annotations: readonly FrameworkAnnotation[], fqns: readonly string[]): boolean {
  return annotations.some(a => a.resolvedFqn !== undefined && fqns.includes(a.resolvedFqn));
}

export function isEntity(annotations: readonly FrameworkAnnotation[]): boolean {
  return hasAnnotation(annotations, JPA_ENTITY_FQNS);
}

export function isRelationField(annotations: readonly FrameworkAnnotation[]): boolean {
  return hasAnnotation(annotations, JPA_RELATION_FQNS);
}
