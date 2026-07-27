// input: A V1 SourceIndex instance.
// output: A RouterIndex-compatible async facade.
// pos: Temporary Step 7 coexistence bridge (JAVA_LSP_INDEX_BACKEND=v1); deleted
//      alongside SourceIndex once the V2 benchmark gate passes (Task 22 Step 8).
import type { AnchorFacts } from "./java-index/index-types.js";
import type { RouterIndex, RouterIndexStatus } from "./java-index/router-java-index.js";
import { SourceIndex } from "./source-index.js";

export function wrapSourceIndex(sourceIndex: SourceIndex): RouterIndex {
  return {
    async ensureFresh(): Promise<void> {
      // V1 facts are computed synchronously on demand inside factsFor/methodAt;
      // there is no separate foreground-refresh step to perform here.
    },
    async queryAnchor(): Promise<AnchorFacts | undefined> {
      // V1 has no AST anchor resolution; callers fall back to factsFor/methodAt.
      return undefined;
    },
    async factsFor(inputFile: string) {
      return sourceIndex.factsFor(inputFile);
    },
    async methodAt(inputFile: string, line: number) {
      return sourceIndex.methodAt(inputFile, line);
    },
    async findImplementers(typeName: string, limit?: number, scan?: boolean) {
      const facts = sourceIndex.findImplementers(typeName, scan);
      return limit === undefined ? facts : facts.slice(0, limit);
    },
    async findTypeReferences(typeName: string, limit?: number) {
      const facts = sourceIndex.findTypeReferences(typeName);
      return limit === undefined ? facts : facts.slice(0, limit);
    },
    async findImporters(typeName: string, limit?: number) {
      const facts = sourceIndex.findImporters(typeName);
      return limit === undefined ? facts : facts.slice(0, limit);
    },
    async findTypeDefinitions(typeNames: readonly string[], limit?: number) {
      const facts = sourceIndex.findTypeDefinitions(typeNames);
      return limit === undefined ? facts : facts.slice(0, limit);
    },
    async routerStatus(): Promise<RouterIndexStatus> {
      return {
        ...sourceIndex.status(),
        javaIndex: {
          state: "NEW",
          indexedGeneration: 0,
          files: 0,
          types: 0,
          methods: 0,
          edges: 0,
          snapshotBytes: 0,
          pendingForeground: 0,
          pendingBackground: 0,
          coverage: []
        },
        openSource: "cold",
        coverage: "degraded"
      };
    }
  };
}
