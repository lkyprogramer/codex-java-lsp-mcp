// input: JavaIndex store facts after AST extract/resolve.
// output: Structural knowledge-graph nodes/edges (N1). Call/framework/dataflow edges stay empty until N2.
// pos: N1 builder. Reuses ast-extractor facts; does not re-parse.
import type { JavaFieldFacts, JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts } from "../java-index/index-types.js";
import type { JavaIndexStore } from "../java-index/index-store.js";
import { isStructuralEdgeKind } from "./edge-kinds.js";
import {
  KNOWLEDGE_REPOSITORY_ID,
  knowledgeEdgeId,
  knowledgeExternalTypeId,
  knowledgeFileId,
  knowledgeMemberId,
  knowledgeModuleId,
  knowledgeSourceRootId,
  knowledgeTypeId
} from "./entity-id.js";
import { KnowledgeGraphStore } from "./graph-store.js";
import type { GraphEdge, GraphNode, NodeKind } from "./schema.js";

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function typeNameOf(type: JavaTypeFacts): string {
  return type.fqn || type.simpleName;
}

export function knowledgeIdForType(type: JavaTypeFacts): string {
  return knowledgeTypeId(relativePathOfFileId(type.fileId), typeNameOf(type));
}

export function knowledgeIdForMethod(method: JavaMethodFacts, owner: JavaTypeFacts | undefined): string {
  const typeId = owner
    ? knowledgeIdForType(owner)
    : knowledgeExternalTypeId(method.ownerTypeId);
  return knowledgeMemberId(typeId, method.name, method.signatureKey);
}

function node(
  id: string,
  kind: NodeKind,
  generation: number,
  extra: Partial<GraphNode> = {}
): GraphNode {
  return { id, kind, generation, ...extra };
}

function edge(kind: GraphEdge["kind"], fromId: string, toId: string, generation: number, sourceFile?: string, ordinal = 0): GraphEdge {
  return {
    edgeId: knowledgeEdgeId({ kind, fromId, toId, ordinal }),
    kind,
    fromId,
    toId,
    sourceFile,
    generation
  };
}

export class KnowledgeGraphBuilder {
  constructor(private readonly graph: KnowledgeGraphStore) {}

  rebuildFromStore(store: JavaIndexStore, generation: number): void {
    this.graph.clear();
    this.graph.generation = generation;
    this.ensureRepository(generation);
    const typesByFile = new Map<string, JavaTypeFacts[]>();
    const fieldsByFile = new Map<string, JavaFieldFacts[]>();
    const methodsByFile = new Map<string, JavaMethodFacts[]>();
    const edgesByFile = new Map<string, JavaFileBundle["edges"]>();
    for (const type of store.typesById.values()) {
      const path = relativePathOfFileId(type.fileId);
      const bucket = typesByFile.get(path) ?? [];
      bucket.push(type);
      typesByFile.set(path, bucket);
    }
    for (const field of store.fieldsById.values()) {
      const owner = store.typesById.get(field.ownerTypeId);
      const path = owner ? relativePathOfFileId(owner.fileId) : "";
      if (!path) continue;
      const bucket = fieldsByFile.get(path) ?? [];
      bucket.push(field);
      fieldsByFile.set(path, bucket);
    }
    for (const method of store.methodsById.values()) {
      const owner = store.typesById.get(method.ownerTypeId);
      const path = owner ? relativePathOfFileId(owner.fileId) : "";
      if (!path) continue;
      const bucket = methodsByFile.get(path) ?? [];
      bucket.push(method);
      methodsByFile.set(path, bucket);
    }
    for (const item of store.edgesById.values()) {
      const bucket = edgesByFile.get(item.sourceFile) ?? [];
      bucket.push(item);
      edgesByFile.set(item.sourceFile, bucket);
    }
    for (const file of store.filesByPath.values()) {
      this.addBundle({
        file,
        types: typesByFile.get(file.relativePath) ?? [],
        fields: fieldsByFile.get(file.relativePath) ?? [],
        methods: methodsByFile.get(file.relativePath) ?? [],
        edges: edgesByFile.get(file.relativePath) ?? []
      }, store, generation);
    }
  }

  replaceFile(bundle: JavaFileBundle, store: JavaIndexStore, generation: number): void {
    this.graph.removeFiles([bundle.file.relativePath]);
    this.graph.generation = Math.max(this.graph.generation, generation);
    this.ensureRepository(generation);
    this.addBundle(bundle, store, generation);
  }

  removeFiles(relativePaths: readonly string[]): void {
    this.graph.removeFiles(relativePaths);
    this.graph.generation += 1;
  }

  private ensureRepository(generation: number): void {
    if (!this.graph.nodesById.has(KNOWLEDGE_REPOSITORY_ID)) {
      this.graph.upsertNode(node(KNOWLEDGE_REPOSITORY_ID, "REPOSITORY", generation, { simpleName: "repository" }));
    }
  }

  private addBundle(bundle: JavaFileBundle, store: JavaIndexStore, generation: number): void {
    const owner = bundle.file.relativePath;
    const fileId = knowledgeFileId(owner);
    const moduleId = knowledgeModuleId(bundle.file.module);
    const rootId = knowledgeSourceRootId(bundle.file.sourceRoot);
    this.graph.upsertNode(node(moduleId, "MODULE", generation, { simpleName: bundle.file.module }));
    this.graph.upsertNode(node(rootId, "SOURCE_ROOT", generation, { relativePath: bundle.file.sourceRoot }));
    this.graph.upsertNode(node(fileId, "FILE", generation, {
      relativePath: owner,
      simpleName: owner.split("/").pop(),
      javaIndexId: bundle.file.fileId
    }), owner);
    // Hierarchy above FILE is repo-global; owning it per file would drop
    // MODULE/SOURCE_ROOT rows when a sibling in the same module is edited.
    this.graph.addEdge(edge("CONTAINS", KNOWLEDGE_REPOSITORY_ID, moduleId, generation));
    this.graph.addEdge(edge("CONTAINS", moduleId, rootId, generation));
    this.graph.addEdge(edge("CONTAINS", rootId, fileId, generation, owner), owner);

    const typeByJavaId = new Map(bundle.types.map(type => [type.typeId, type]));
    const knowledgeByJavaId = new Map<string, string>();
    knowledgeByJavaId.set(bundle.file.fileId, fileId);

    for (const type of bundle.types) {
      const typeId = knowledgeIdForType(type);
      knowledgeByJavaId.set(type.typeId, typeId);
      this.graph.upsertNode(node(typeId, "TYPE", generation, {
        relativePath: owner,
        simpleName: type.simpleName,
        javaIndexId: type.typeId
      }), owner);
      if (type.enclosingTypeId && typeByJavaId.has(type.enclosingTypeId)) {
        this.graph.addEdge(edge("CONTAINS", knowledgeIdForType(typeByJavaId.get(type.enclosingTypeId)!), typeId, generation, owner), owner);
      } else {
        this.graph.addEdge(edge("CONTAINS", fileId, typeId, generation, owner), owner);
      }
    }

    for (const field of bundle.fields) {
      const ownerType = typeByJavaId.get(field.ownerTypeId) ?? store.typesById.get(field.ownerTypeId);
      const typeId = ownerType ? knowledgeIdForType(ownerType) : knowledgeExternalTypeId(field.ownerTypeId);
      const fieldId = knowledgeMemberId(typeId, field.name, field.name);
      knowledgeByJavaId.set(field.fieldId, fieldId);
      this.graph.upsertNode(node(fieldId, "FIELD", generation, {
        relativePath: owner,
        simpleName: field.name,
        javaIndexId: field.fieldId
      }), owner);
      this.graph.addEdge(edge("DECLARES", typeId, fieldId, generation, owner), owner);
    }

    for (const method of bundle.methods) {
      const ownerType = typeByJavaId.get(method.ownerTypeId) ?? store.typesById.get(method.ownerTypeId);
      const methodId = knowledgeIdForMethod(method, ownerType);
      knowledgeByJavaId.set(method.methodId, methodId);
      this.graph.upsertNode(node(methodId, method.constructor ? "CONSTRUCTOR" : "METHOD", generation, {
        relativePath: owner,
        simpleName: method.name,
        javaIndexId: method.methodId
      }), owner);
      if (ownerType) {
        this.graph.addEdge(edge("DECLARES", knowledgeIdForType(ownerType), methodId, generation, owner), owner);
      }
      // PARAMETER/LOCAL/STATEMENT stay reserved kinds. N1 does not materialize
      // them; N2b fills parameters that actually participate in data-flow.
    }

    const ordinals = new Map<string, number>();
    for (const staticEdge of bundle.edges) {
      if (!isStructuralEdgeKind(staticEdge.kind)) continue;
      const fromId = this.resolveEndpoint(staticEdge.fromId, knowledgeByJavaId, store);
      const toId = this.resolveEndpoint(staticEdge.toId, knowledgeByJavaId, store);
      if (!fromId || !toId) continue;
      const key = `${staticEdge.kind}:${fromId}->${toId}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      this.graph.addEdge(edge(staticEdge.kind, fromId, toId, generation, owner, ordinal), owner);
      if (staticEdge.kind === "IMPORTS") {
        const fromFile = bundle.file;
        const toType = store.typesById.get(staticEdge.toId);
        const toModule = toType ? store.filesByPath.get(relativePathOfFileId(toType.fileId))?.module : undefined;
        if (toModule && toModule !== fromFile.module) {
          this.graph.addEdge(
            edge("MODULE_DEPENDS_ON", knowledgeModuleId(fromFile.module), knowledgeModuleId(toModule), generation, owner),
            owner
          );
        }
      }
    }
  }

  private resolveEndpoint(
    javaIndexId: string,
    local: Map<string, string>,
    store: JavaIndexStore
  ): string | undefined {
    const hit = local.get(javaIndexId);
    if (hit) return hit;
    const type = store.typesById.get(javaIndexId);
    if (type) return knowledgeIdForType(type);
    const method = store.methodsById.get(javaIndexId);
    if (method) {
      return knowledgeIdForMethod(method, store.typesById.get(method.ownerTypeId));
    }
    const field = store.fieldsById.get(javaIndexId);
    if (field) {
      const owner = store.typesById.get(field.ownerTypeId);
      return owner ? knowledgeMemberId(knowledgeIdForType(owner), field.name, field.name) : knowledgeExternalTypeId(field.fieldId);
    }
    if (javaIndexId.startsWith("file:")) return knowledgeFileId(relativePathOfFileId(javaIndexId));
    if (javaIndexId.startsWith("external:") || javaIndexId.startsWith("type:")) {
      const name = javaIndexId.replace(/^external:/, "").replace(/^type:/, "");
      const id = knowledgeExternalTypeId(name);
      if (!this.graph.nodesById.has(id)) {
        this.graph.upsertNode(node(id, "TYPE", this.graph.generation, { simpleName: name.split(".").pop(), javaIndexId }));
      }
      return id;
    }
    return undefined;
  }
}
