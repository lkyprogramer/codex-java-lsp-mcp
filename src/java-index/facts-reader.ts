import type {
  AnchorFacts,
  IndexedReference,
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  JavaTypeLookupResult,
  StaticEdge,
  StaticEdgeKind
} from "./index-types.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";

export type FactsLookup<V> = {
  get(key: string): V | undefined;
  has(key: string): boolean;
  readonly size: number;
};

export type FactsReader = {
  readonly typesById: FactsLookup<JavaTypeFacts>;
  readonly methodsById: FactsLookup<JavaMethodFacts>;
  readonly fieldsById: FactsLookup<JavaFieldFacts>;
  readonly filesByPath: FactsLookup<JavaFileFacts>;
  readonly typeIdByFqn: FactsLookup<string>;
  readonly typeIdsBySimpleName: FactsLookup<ReadonlySet<string>>;
  readonly methodIdsByOwnerAndName: FactsLookup<ReadonlySet<string>>;
  files(paths: readonly string[]): JavaFileBundle[];
  file(path: string): JavaFileFacts | undefined;
  methodsOfOwner(typeId: string): JavaMethodFacts[];
  typeByFqn(fqn: string): JavaTypeFacts | undefined;
  implementers(typeId: string, limit?: number): JavaTypeFacts[];
  callers(methodId: string, limit?: number): IndexedReference[];
  callees(methodId: string, limit?: number): IndexedReference[];
  typeReferencers(typeId: string, kinds: ReadonlySet<StaticEdgeKind>, limit?: number): IndexedReference[];
  methodsWithParameterTypes(typeIds: readonly string[], limit?: number): string[];
  anchor(path: string, line: number, col: number): AnchorFacts | undefined;
  typeLookup(typeText: string, scopeFile?: string): JavaTypeLookupResult;
  myBatisResource(path: string): MyBatisMapperResourceFacts | undefined;
  myBatisResourceForNamespace(ns: string): MyBatisMapperResourceFacts | undefined;
  myBatisStatement(qid: string): MyBatisMapperResourceFacts["statements"][number] | undefined;
  repositoryFactMarkers(importPrefixes: readonly string[], annotationPrefixes: readonly string[]): {
    importPrefixFound: boolean;
    annotationPrefixFound: boolean;
  };
  implementersOfAny(typeIds: readonly string[]): string[];
  typesBySimpleNameOrFqn(simple: string, fqn: string): JavaTypeFacts[];
};

export type FactsIter = {
  iterTypes(): IterableIterator<JavaTypeFacts>;
  iterFields(): IterableIterator<JavaFieldFacts>;
  iterMethods(): IterableIterator<JavaMethodFacts>;
  iterEdges(): IterableIterator<StaticEdge>;
  iterFiles(): IterableIterator<JavaFileFacts>;
};
