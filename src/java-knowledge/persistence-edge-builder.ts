// input: JavaIndex types/methods plus MyBatis mapper resources already in the store.
// output: Persistence knowledge-graph edges (mapper↔statement, statement↔entity, Template/Repository↔entity, JPA relations).
// pos: N2a-03. Template/Repository matching is a name suffix + generic type argument, never a class allowlist.
import type { JavaFileBundle, JavaTypeFacts, JavaTypeRef } from "../java-index/index-types.js";
import type { FactsReader } from "../java-index/facts-reader.js";
import {
  myBatisStatementId,
  type MyBatisMapperResourceFacts
} from "../java-index/mybatis-types.js";
import type { KnowledgeGraphStore } from "./graph-store.js";
import { knowledgeEdgeId, knowledgeExternalTypeId, knowledgeFileId, knowledgeTypeId } from "./entity-id.js";
import type { EdgeKind } from "./edge-kinds.js";

function knowledgeIdForType(type: JavaTypeFacts): string {
  const path = type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId;
  return knowledgeTypeId(path, type.fqn || type.simpleName);
}
import type { NodeKind } from "./schema.js";

const JPA_RELATIONS = new Set(["OneToMany", "ManyToOne", "OneToOne", "ManyToMany", "JoinColumn"]);

function push(
  graph: KnowledgeGraphStore,
  kind: EdgeKind,
  fromId: string,
  toId: string,
  generation: number,
  ownerFile?: string
): void {
  graph.addEdge({
    edgeId: knowledgeEdgeId({ kind, fromId, toId, ordinal: 0 }),
    kind,
    fromId,
    toId,
    sourceFile: ownerFile,
    generation
  }, ownerFile);
}

function upsert(
  graph: KnowledgeGraphStore,
  id: string,
  kind: NodeKind,
  generation: number,
  extra: { relativePath?: string; simpleName?: string; javaIndexId?: string } = {},
  ownerFile?: string
): void {
  graph.upsertNode({ id, kind, generation, ...extra }, ownerFile);
}

function resolveNamedType(name: string | undefined, store: FactsReader): string | undefined {
  if (!name) return undefined;
  const byFqn = store.typeByFqn(name);
  if (byFqn) return knowledgeIdForType(byFqn);
  const simple = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const hits = store.typesBySimpleNameOrFqn(simple, name);
  if (hits.length === 1) return knowledgeIdForType(hits[0]!);
  if (name.includes(".")) return knowledgeExternalTypeId(name);
  return undefined;
}

function typeArgEntity(ref: JavaTypeRef | undefined, store: FactsReader): string | undefined {
  const argument = ref?.typeArguments[0];
  if (!argument) return undefined;
  return resolveNamedType(argument.qualifiedName ?? argument.simpleName ?? argument.text, store)
    ?? typeRefResolved(argument, store);
}

function typeRefResolved(ref: JavaTypeRef, store: FactsReader): string | undefined {
  if (ref.resolution.state === "RESOLVED_REPO") {
    const type = store.typesById.get(ref.resolution.typeId);
    return type ? knowledgeIdForType(type) : undefined;
  }
  if (ref.resolution.state === "EXTERNAL") return knowledgeExternalTypeId(ref.resolution.qualifiedName);
  return resolveNamedType(ref.qualifiedName ?? ref.simpleName ?? ref.text, store);
}

function isRepositoryLike(type: JavaTypeFacts): boolean {
  return type.simpleName.endsWith("Template") || type.simpleName.endsWith("Repository");
}

function addMapperBindings(
  graph: KnowledgeGraphStore,
  type: JavaTypeFacts,
  bundle: JavaFileBundle,
  resource: MyBatisMapperResourceFacts,
  store: FactsReader,
  generation: number,
  resolve: (javaIndexId: string) => string | undefined
): void {
  const ownerFile = bundle.file.relativePath;
  const xmlPath = resource.relativePath;
  upsert(graph, knowledgeFileId(xmlPath), "JAVA_RESOURCE", generation, { relativePath: xmlPath, simpleName: xmlPath.split("/").pop() }, xmlPath);
  upsert(graph, `mybatis-ns:${resource.namespace}`, "MYBATIS_NAMESPACE", generation, { simpleName: resource.namespace }, xmlPath);
  for (const statement of resource.statements) {
    const statementNodeId = myBatisStatementId(statement.namespace, statement.id);
    upsert(graph, statementNodeId, "MYBATIS_STATEMENT", generation, {
      relativePath: xmlPath,
      simpleName: statement.id,
      javaIndexId: statement.statementId
    }, xmlPath);
    const method = bundle.methods.find(item => item.ownerTypeId === type.typeId && item.name === statement.id);
    const methodId = method ? resolve(method.methodId) : undefined;
    if (methodId) push(graph, "MYBATIS_METHOD_BINDS_STATEMENT", methodId, statementNodeId, generation, ownerFile);
    const entity = resolveNamedType(statement.resultType, store)
      ?? resolveNamedType(statement.parameterType, store)
      ?? (statement.resultMap
        ? resolveNamedType(resource.resultMaps.find(map => map.id === statement.resultMap)?.type, store)
        : undefined);
    if (entity) push(graph, "MYBATIS_STATEMENT_USES_ENTITY", statementNodeId, entity, generation, xmlPath);
  }
}

export function addPersistenceEdges(
  graph: KnowledgeGraphStore,
  bundle: JavaFileBundle,
  store: FactsReader,
  generation: number,
  resolve: (javaIndexId: string) => string | undefined
): void {
  const ownerFile = bundle.file.relativePath;
  for (const type of bundle.types) {
    const typeId = resolve(type.typeId);
    if (!typeId) continue;
    if (type.fqn) {
      const resource = store.myBatisResourceForNamespace(type.fqn);
      if (resource) addMapperBindings(graph, type, bundle, resource, store, generation, resolve);
    }
    if (isRepositoryLike(type)) {
      const entity = typeArgEntity(type.extends[0], store) ?? typeArgEntity(type.implements[0], store);
      if (entity) push(graph, "REPOSITORY_MANAGES_ENTITY", typeId, entity, generation, ownerFile);
    }
    const isEntity = type.annotations.some(annotation => {
      const name = (annotation.qualifiedName ?? annotation.name).replace(/^@/, "");
      return name === "Entity" || name.endsWith(".Entity");
    });
    if (!isEntity) continue;
    for (const field of bundle.fields) {
      if (field.ownerTypeId !== type.typeId) continue;
      const relation = field.annotations.some(annotation => {
        const name = (annotation.qualifiedName ?? annotation.name).replace(/^@/, "");
        return JPA_RELATIONS.has(name) || [...JPA_RELATIONS].some(item => name.endsWith(`.${item}`));
      });
      if (!relation) continue;
      const target = typeRefResolved(field.type, store);
      if (target) push(graph, "JPA_RELATION", typeId, target, generation, ownerFile);
    }
  }
}
