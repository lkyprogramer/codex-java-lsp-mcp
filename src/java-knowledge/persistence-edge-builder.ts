// input: JavaIndex types/methods plus MyBatis mapper resources already in the store.
// output: Persistence knowledge-graph edges (mapper↔statement, statement↔entity, Template/Repository↔entity, JPA relations).
// pos: N2a-03. Template/Repository matching is a name suffix + generic type argument, never a class allowlist.
import type { JavaFileBundle, JavaTypeFacts, JavaTypeRef } from "../java-index/index-types.js";
import type { FactsReader } from "../java-index/facts-reader.js";
import {
  myBatisStatementId,
  type MyBatisMapperResourceFacts
} from "../java-index/mybatis-types.js";
import type { GraphSink } from "./graph-fragment.js";
import { knowledgeEdgeId, knowledgeExternalTypeId, knowledgeFileId, knowledgeIdForType } from "./entity-id.js";
import type { EdgeKind } from "./edge-kinds.js";
import type { NodeKind } from "./schema.js";

const JPA_RELATIONS = new Set(["OneToMany", "ManyToOne", "OneToOne", "ManyToMany", "JoinColumn"]);

function push(
  graph: GraphSink,
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
  graph: GraphSink,
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
  // Several repo declarations of one FQN and no referring location here:
  // stay unbound rather than guess (and never call it external).
  const byFqn = store.typesByFqn(name);
  if (byFqn.length === 1) return knowledgeIdForType(byFqn[0]!);
  if (byFqn.length > 1) return undefined;
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

/** Simple names this file's repository types look up repo-wide (typeArgEntity), whatever the argument resolved to. */
export function repositoryEntityNames(bundle: JavaFileBundle): string[] {
  const names: string[] = [];
  for (const type of bundle.types) {
    if (!isRepositoryLike(type)) continue;
    for (const ref of [type.extends[0], type.implements[0]]) {
      const argument = ref?.typeArguments[0];
      const name = argument ? argument.qualifiedName ?? argument.simpleName ?? argument.text : undefined;
      if (name) names.push(name.slice(name.lastIndexOf(".") + 1));
    }
  }
  return names;
}

function addMapperBindings(
  graph: GraphSink,
  type: JavaTypeFacts,
  bundle: JavaFileBundle,
  resource: MyBatisMapperResourceFacts,
  store: FactsReader,
  generation: number,
  resolve: (javaIndexId: string) => string | undefined
): void {
  // The mapper file owns what its binding derives from the XML: an XML edit
  // resyncs every declaration of the namespace, and a mapper that stops
  // binding drops these rows with its own (MAC-05; owning them by the XML
  // path left them behind when the Java side changed).
  const ownerFile = bundle.file.relativePath;
  const xmlPath = resource.relativePath;
  upsert(graph, knowledgeFileId(xmlPath), "JAVA_RESOURCE", generation, { relativePath: xmlPath, simpleName: xmlPath.split("/").pop() }, ownerFile);
  upsert(graph, `mybatis-ns:${resource.namespace}`, "MYBATIS_NAMESPACE", generation, { simpleName: resource.namespace }, ownerFile);
  for (const statement of resource.statements) {
    const statementNodeId = myBatisStatementId(statement.namespace, statement.id);
    upsert(graph, statementNodeId, "MYBATIS_STATEMENT", generation, {
      relativePath: xmlPath,
      simpleName: statement.id,
      javaIndexId: statement.statementId
    }, ownerFile);
    const method = bundle.methods.find(item => item.ownerTypeId === type.typeId && item.name === statement.id);
    const methodId = method ? resolve(method.methodId) : undefined;
    if (methodId) push(graph, "MYBATIS_METHOD_BINDS_STATEMENT", methodId, statementNodeId, generation, ownerFile);
    const entity = resolveNamedType(statement.resultType, store)
      ?? resolveNamedType(statement.parameterType, store)
      ?? (statement.resultMap
        ? resolveNamedType(resource.resultMaps.find(map => map.id === statement.resultMap)?.type, store)
        : undefined);
    if (entity) push(graph, "MYBATIS_STATEMENT_USES_ENTITY", statementNodeId, entity, generation, ownerFile);
  }
}

export function addPersistenceEdges(
  graph: GraphSink,
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
