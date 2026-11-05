// input: JavaIndex store facts after AST extract/resolve.
// output: Structural + N2a call/framework/persistence knowledge-graph edges.
// pos: N1/N2a builder. Reuses ast-extractor facts; does not re-parse.
import type { JavaFileBundle, JavaMethodFacts, JavaTypeFacts } from "../java-index/index-types.js";
import type { FactsIter, FactsReader } from "../java-index/facts-reader.js";
import { addCallEdges } from "./call-resolver.js";
import { isStructuralEdgeKind } from "./edge-kinds.js";
import { addFrameworkEdges } from "./framework-edge-builder.js";
import { addPersistenceEdges } from "./persistence-edge-builder.js";
import {
  KNOWLEDGE_REPOSITORY_ID,
  knowledgeEdgeId,
  knowledgeExternalTypeId,
  knowledgeFileId,
  knowledgeIdForType,
  knowledgeMemberId,
  knowledgeModuleId,
  knowledgeSourceRootId
} from "./entity-id.js";
import { GraphFragment } from "./graph-fragment.js";
import type { KnowledgeGraphStore } from "./graph-reader.js";
import type { GraphEdge, GraphNode, NodeKind } from "./schema.js";

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
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

  /** An empty graph still has its repository root, as every delta leaves it. */
  reset(generation: number): void {
    this.graph.clear();
    this.graph.generation = generation;
    this.ensureRepository(generation);
  }

  rebuildFromStore(store: FactsReader & FactsIter, generation: number): void {
    this.reset(generation);
    for (const file of store.iterFiles()) {
      const bundle = store.files([file.relativePath])[0];
      if (bundle) this.appendFile(bundle, store, generation);
    }
  }

  /** Add one file's rows. Full and delta share this: the store applies the
   * file's fragment as a set, so a fresh graph only inserts. */
  appendFile(bundle: JavaFileBundle, store: FactsReader, generation: number): void {
    this.replaceFile(bundle, store, generation);
  }

  replaceFile(bundle: JavaFileBundle, store: FactsReader, generation: number): void {
    this.graph.generation = Math.max(this.graph.generation, generation);
    this.ensureRepository(generation);
    const fragment = new GraphFragment(bundle.file.relativePath);
    this.addBundle(fragment, bundle, store, generation);
    this.graph.replaceOwner(fragment);
  }

  removeFiles(relativePaths: readonly string[]): void {
    this.graph.removeFiles(relativePaths);
    this.graph.generation += 1;
  }

  // The repository root is the only ownerless row: it exists in every graph.
  private ensureRepository(generation: number): void {
    if (!this.graph.nodesById.has(KNOWLEDGE_REPOSITORY_ID)) {
      this.graph.upsertNode(node(KNOWLEDGE_REPOSITORY_ID, "REPOSITORY", generation, { simpleName: "repository" }));
    }
  }

  private addBundle(graph: GraphFragment, bundle: JavaFileBundle, store: FactsReader, generation: number): void {
    const owner = bundle.file.relativePath;
    const fileId = knowledgeFileId(owner);
    const moduleId = knowledgeModuleId(bundle.file.module);
    const rootId = knowledgeSourceRootId(bundle.file.sourceRoot);
    // Hierarchy above FILE is shared: every file of a module owns the module
    // and its CONTAINS edges, so they go with the module's last file.
    graph.upsertNode(node(moduleId, "MODULE", generation, { simpleName: bundle.file.module }), owner);
    graph.upsertNode(node(rootId, "SOURCE_ROOT", generation, { relativePath: bundle.file.sourceRoot }), owner);
    graph.upsertNode(node(fileId, "FILE", generation, {
      relativePath: owner,
      simpleName: owner.split("/").pop(),
      javaIndexId: bundle.file.fileId
    }), owner);
    graph.addEdge(edge("CONTAINS", KNOWLEDGE_REPOSITORY_ID, moduleId, generation), owner);
    graph.addEdge(edge("CONTAINS", moduleId, rootId, generation), owner);
    graph.addEdge(edge("CONTAINS", rootId, fileId, generation, owner), owner);

    const typeByJavaId = new Map(bundle.types.map(type => [type.typeId, type]));
    const knowledgeByJavaId = new Map<string, string>();
    knowledgeByJavaId.set(bundle.file.fileId, fileId);

    for (const type of bundle.types) {
      const typeId = knowledgeIdForType(type);
      knowledgeByJavaId.set(type.typeId, typeId);
      graph.upsertNode(node(typeId, "TYPE", generation, {
        relativePath: owner,
        simpleName: type.simpleName,
        javaIndexId: type.typeId
      }), owner);
      if (type.enclosingTypeId && typeByJavaId.has(type.enclosingTypeId)) {
        graph.addEdge(edge("CONTAINS", knowledgeIdForType(typeByJavaId.get(type.enclosingTypeId)!), typeId, generation, owner), owner);
      } else {
        graph.addEdge(edge("CONTAINS", fileId, typeId, generation, owner), owner);
      }
    }

    for (const field of bundle.fields) {
      const ownerType = typeByJavaId.get(field.ownerTypeId) ?? store.typesById.get(field.ownerTypeId);
      const typeId = ownerType ? knowledgeIdForType(ownerType) : knowledgeExternalTypeId(field.ownerTypeId);
      const fieldId = knowledgeMemberId(typeId, field.name, field.name);
      knowledgeByJavaId.set(field.fieldId, fieldId);
      graph.upsertNode(node(fieldId, "FIELD", generation, {
        relativePath: owner,
        simpleName: field.name,
        javaIndexId: field.fieldId
      }), owner);
      graph.addEdge(edge("DECLARES", typeId, fieldId, generation, owner), owner);
    }

    for (const method of bundle.methods) {
      const ownerType = typeByJavaId.get(method.ownerTypeId) ?? store.typesById.get(method.ownerTypeId);
      const methodId = knowledgeIdForMethod(method, ownerType);
      knowledgeByJavaId.set(method.methodId, methodId);
      graph.upsertNode(node(methodId, method.constructor ? "CONSTRUCTOR" : "METHOD", generation, {
        relativePath: owner,
        simpleName: method.name,
        javaIndexId: method.methodId
      }), owner);
      if (ownerType) {
        graph.addEdge(edge("DECLARES", knowledgeIdForType(ownerType), methodId, generation, owner), owner);
      }
      // PARAMETER/LOCAL/STATEMENT stay reserved kinds. N1 does not materialize
      // them; N2b fills parameters that actually participate in data-flow.
    }

    const ordinals = new Map<string, number>();
    for (const staticEdge of bundle.edges) {
      if (!isStructuralEdgeKind(staticEdge.kind)) continue;
      const fromId = this.resolveEndpoint(graph, staticEdge.fromId, knowledgeByJavaId, store, generation);
      const toId = this.resolveEndpoint(graph, staticEdge.toId, knowledgeByJavaId, store, generation);
      if (!fromId || !toId) continue;
      const key = `${staticEdge.kind}:${fromId}->${toId}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      graph.addEdge(edge(staticEdge.kind, fromId, toId, generation, owner, ordinal), owner);
      if (staticEdge.kind === "IMPORTS") {
        const fromFile = bundle.file;
        const toType = store.typesById.get(staticEdge.toId);
        const toModule = toType ? store.filesByPath.get(relativePathOfFileId(toType.fileId))?.module : undefined;
        if (toModule && toModule !== fromFile.module) {
          graph.addEdge(
            edge("MODULE_DEPENDS_ON", knowledgeModuleId(fromFile.module), knowledgeModuleId(toModule), generation, owner),
            owner
          );
        }
      }
    }

    const resolve = (javaIndexId: string) => this.resolveEndpoint(graph, javaIndexId, knowledgeByJavaId, store, generation);
    addCallEdges(graph, bundle, store, generation, resolve);
    addFrameworkEdges(graph, bundle, store, generation, resolve);
    addPersistenceEdges(graph, bundle, store, generation, resolve);
  }

  private resolveEndpoint(
    graph: GraphFragment,
    javaIndexId: string,
    local: Map<string, string>,
    store: FactsReader,
    generation: number
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
      // Owned by each referring file, so it goes with the last reference.
      graph.upsertNode(node(id, "TYPE", generation, { simpleName: name.split(".").pop(), javaIndexId }), graph.owner);
      return id;
    }
    return undefined;
  }
}
