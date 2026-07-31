// input: build-file Lombok/APT detection (src/generated-code.ts) plus the
//        current task's anchor files' own Lombok annotations, read through
//        FrameworkIndexView.
// output: whether this task actually needs Lombok-generated member binding
//         that the JDT javaagent cannot currently provide - a result-level
//         gap, never a candidate edge (Lombok generates no source the AST
//         extractor ever sees, so there is nothing to link to).
// pos: Task 29 commit 4. Not a FrameworkAdapter - generated-code.ts already
//      owns Lombok/APT detection; this only decides whether the task in
//      front of us depends on it, and is called directly from index.ts.
import { detectGeneratedCode, type GeneratedCodeStatus } from "../../generated-code.js";
import type { FrameworkFileFacts, FrameworkIndexView, FrameworkTypeDeclaration } from "../../java-index/framework-index-view.js";

/**
 * Lombok annotations that synthesize members (getters/setters/constructors/
 * builders/equals/hashCode/toString) a JDT session without the lombok
 * javaagent cannot see. Annotations that only affect logging or null-checks
 * (@Slf4j, @NonNull, ...) are deliberately excluded - they do not add
 * member-binding surface a caller would need to resolve.
 */
const LOMBOK_MEMBER_GENERATING_ANNOTATIONS: ReadonlySet<string> = new Set([
  "lombok.Data",
  "lombok.Getter",
  "lombok.Setter",
  "lombok.Builder",
  "lombok.experimental.SuperBuilder",
  "lombok.AllArgsConstructor",
  "lombok.NoArgsConstructor",
  "lombok.RequiredArgsConstructor",
  "lombok.Value",
  "lombok.EqualsAndHashCode",
  "lombok.ToString",
  "lombok.With"
]);

export type LombokCompleteness = {
  semantics: "OK" | "INCOMPLETE" | "NOT_DETECTED";
  /**
   * True only when the javaagent is missing/disabled AND this task's own
   * anchors touch a Lombok-generated-member type - the one condition that
   * actually warrants a result-level gap message, per the plan's "Lombok
   * detected AND javaagent missing/disabled AND task requires generated
   * member binding" rule.
   */
  taskGapDetected: boolean;
};

export async function lombokCompleteness(
  repoRoot: string,
  anchorPaths: readonly string[],
  frameworkIndex: FrameworkIndexView,
  generation?: number
): Promise<LombokCompleteness> {
  const generatedCode = detectGeneratedCode(repoRoot);
  const semantics = toSemantics(generatedCode);
  // Cheap build-file check first; only pay for the fact lookup below when
  // there is actually a gap to explain.
  if (!generatedCode.lombok.detected || generatedCode.lombok.agentEnabled) {
    return { semantics, taskGapDetected: false };
  }
  const facts = await frameworkIndex.frameworkFactsForFiles(anchorPaths, generation);
  return { semantics, taskGapDetected: facts.some(fileRequiresGeneratedMemberBinding) };
}

function fileRequiresGeneratedMemberBinding(facts: FrameworkFileFacts): boolean {
  return facts.types.some(typeRequiresGeneratedMemberBinding);
}

function typeRequiresGeneratedMemberBinding(type: FrameworkTypeDeclaration): boolean {
  return type.annotations.some(annotation =>
    annotation.resolvedFqn !== undefined && LOMBOK_MEMBER_GENERATING_ANNOTATIONS.has(annotation.resolvedFqn));
}

function toSemantics(generatedCode: GeneratedCodeStatus): LombokCompleteness["semantics"] {
  if (generatedCode.generatedCodeSemantics === "ok") return "OK";
  if (generatedCode.generatedCodeSemantics === "incomplete") return "INCOMPLETE";
  return "NOT_DETECTED";
}
