import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { resolveRoutingPolicy } from "../routing-policy.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import { collectTypeGraphCandidates } from "./candidate-collectors.js";

const options: ImpactOptions = {
  anchors: [],
  mode: "balanced",
  profile: "auto",
  semanticPolicy: "fast",
  semanticTimeoutMs: 1_500,
  testReadMode: "defer",
  focusModules: [],
  excludeModules: [],
  taskKeywords: [],
  crossModulePolicy: "auto"
};

const anchor: ResolvedAnchor = {
  id: "A1",
  absolutePath: "/repo/src/main/java/demo/OrderPort.java",
  path: "src/main/java/demo/OrderPort.java",
  sourceSet: "main",
  line: 1,
  column: 1,
  profile: "repository",
  symbolName: "findById",
  methodName: "findById",
  className: "OrderPort",
  kind: "Method"
};

const implementation: JavaSourceFacts = {
  absolutePath: "/repo/src/main/java/demo/OrderPortImpl.java",
  path: "src/main/java/demo/OrderPortImpl.java",
  sourceSet: "main",
  packageName: "demo",
  typeName: "OrderPortImpl",
  kind: "class",
  implementsTypes: ["OrderPort"],
  referencedTypes: [],
  imports: [],
  wildcardImports: [],
  annotations: [],
  methods: [],
  factSource: "javaIndex"
};

test("type graph returns the exact implementation facts it merged", async () => {
  const candidates = new Map<string, CandidateFile>();
  const implementations = await collectTypeGraphCandidates({
    candidates,
    anchors: [anchor],
    options,
    javaIndex: {
      factsFor: async () => ({ ...implementation, absolutePath: anchor.absolutePath, kind: "interface" }),
      findImplementers: async () => [implementation]
    } as never,
    routingPolicy: resolveRoutingPolicy("/repo")
  });

  assert.deepEqual(implementations, [implementation]);
  assert.ok(candidates.has(implementation.absolutePath));
});
