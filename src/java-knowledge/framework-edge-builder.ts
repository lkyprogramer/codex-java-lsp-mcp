// input: JavaIndex types/fields/methods plus already-resolved ANNOTATED_WITH / call facts.
// output: Spring inject/bean/event knowledge-graph edges. Annotation set matches the existing Spring adapter.
// pos: N2a-02. Does not invent extra annotations. Multi-implementer injection binds the declared type only.
import type { JavaAnnotationFact, JavaFileBundle, JavaMethodFacts, JavaTypeFacts, JavaTypeRef } from "../java-index/index-types.js";
import type { FactsReader } from "../java-index/facts-reader.js";
import type { KnowledgeGraphStore } from "./graph-reader.js";
import { knowledgeEdgeId, knowledgeExternalTypeId, knowledgeTypeId } from "./entity-id.js";
import type { EdgeKind } from "./edge-kinds.js";

function knowledgeIdForType(type: JavaTypeFacts): string {
  const path = type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId;
  return knowledgeTypeId(path, type.fqn || type.simpleName);
}

const AUTOWIRED = "org.springframework.beans.factory.annotation.Autowired";
const EVENT_LISTENER = "org.springframework.context.event.EventListener";
const BEAN = "org.springframework.context.annotation.Bean";
const PUBLISHER = "org.springframework.context.ApplicationEventPublisher";

function annotationNames(annotations: readonly JavaAnnotationFact[]): Set<string> {
  const names = new Set<string>();
  for (const annotation of annotations) {
    const raw = (annotation.qualifiedName ?? annotation.name).replace(/^@/, "");
    names.add(raw);
    const simple = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    names.add(simple);
  }
  return names;
}

function hasName(annotations: readonly JavaAnnotationFact[], fqn: string): boolean {
  const names = annotationNames(annotations);
  const simple = fqn.slice(fqn.lastIndexOf(".") + 1);
  return names.has(fqn) || names.has(simple);
}

function typeRefId(ref: JavaTypeRef | undefined, store: FactsReader): string | undefined {
  if (!ref) return undefined;
  if (ref.resolution.state === "RESOLVED_REPO") {
    const type = store.typesById.get(ref.resolution.typeId);
    return type ? knowledgeIdForType(type) : undefined;
  }
  if (ref.resolution.state === "EXTERNAL") return knowledgeExternalTypeId(ref.resolution.qualifiedName);
  return undefined;
}

function push(
  graph: KnowledgeGraphStore,
  kind: EdgeKind,
  fromId: string,
  toId: string,
  generation: number,
  ownerFile: string
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

function injectingConstructor(methods: readonly JavaMethodFacts[]): JavaMethodFacts | undefined {
  const constructors = methods.filter(method => method.constructor);
  const autowired = constructors.filter(method => hasName(method.annotations, AUTOWIRED));
  if (autowired.length === 1) return autowired[0];
  if (constructors.length === 1) return constructors[0];
  return undefined;
}

export function addFrameworkEdges(
  graph: KnowledgeGraphStore,
  bundle: JavaFileBundle,
  store: FactsReader,
  generation: number,
  resolve: (javaIndexId: string) => string | undefined
): void {
  const ownerFile = bundle.file.relativePath;
  const methodsByType = new Map<string, JavaMethodFacts[]>();
  for (const method of bundle.methods) {
    const bucket = methodsByType.get(method.ownerTypeId) ?? [];
    bucket.push(method);
    methodsByType.set(method.ownerTypeId, bucket);
  }

  for (const type of bundle.types) {
    const typeId = resolve(type.typeId);
    if (!typeId) continue;
    const methods = methodsByType.get(type.typeId) ?? [];
    const constructor = injectingConstructor(methods);
    if (constructor) {
      const fromId = resolve(constructor.methodId) ?? typeId;
      for (const parameter of constructor.parameters) {
        const toId = typeRefId(parameter.type, store);
        if (toId) push(graph, "SPRING_INJECTS", fromId, toId, generation, ownerFile);
      }
    }
    for (const field of bundle.fields) {
      if (field.ownerTypeId !== type.typeId) continue;
      if (!hasName(field.annotations, AUTOWIRED)) continue;
      const fieldId = resolve(field.fieldId);
      const toId = typeRefId(field.type, store);
      if (fieldId && toId) push(graph, "SPRING_INJECTS", fieldId, toId, generation, ownerFile);
    }
    for (const method of methods) {
      const methodId = resolve(method.methodId);
      if (!methodId) continue;
      if (hasName(method.annotations, BEAN)) {
        const toId = typeRefId(method.returnType, store);
        if (toId) push(graph, "SPRING_BEAN_BINDS_TO", methodId, toId, generation, ownerFile);
      }
      if (hasName(method.annotations, EVENT_LISTENER)) {
        const toId = typeRefId(method.parameters[0]?.type, store);
        if (toId) push(graph, "CONSUMES_EVENT", methodId, toId, generation, ownerFile);
      }
      for (const call of method.callSites) {
        if (call.name !== "publishEvent" || call.arity !== 1) continue;
        const receiver = call.receiverDeclaredType;
        const receiverFqn = receiver?.resolution.state === "EXTERNAL"
          ? receiver.resolution.qualifiedName
          : receiver?.resolution.state === "RESOLVED_REPO"
            ? store.typesById.get(receiver.resolution.typeId)?.fqn
            : undefined;
        const isPublisher = receiverFqn === PUBLISHER || (receiver?.text.includes("ApplicationEventPublisher") ?? false);
        if (!isPublisher) continue;
        const eventId = typeRefId(call.argumentTypeHints[0], store);
        if (eventId) push(graph, "PUBLISHES_EVENT", methodId, eventId, generation, ownerFile);
      }
    }
  }
}

export function isAutowiredAnnotation(annotations: readonly JavaAnnotationFact[]): boolean {
  return hasName(annotations, AUTOWIRED);
}
