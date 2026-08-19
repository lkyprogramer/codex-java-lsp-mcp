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
  methods: [
    { name: "findById", line: 77, endLine: 90, referencedTypes: [], relations: [] }
  ],
  factSource: "javaIndex"
};

test("type graph returns the exact implementation facts it merged", async () => {
  const candidates = new Map<string, CandidateFile>();
  let hydrate: boolean | undefined;
  const implementations = await collectTypeGraphCandidates({
    candidates,
    anchors: [anchor],
    options,
    javaIndex: {
      factsFor: async () => ({ ...implementation, absolutePath: anchor.absolutePath, kind: "interface" }),
      findImplementers: async (
        _typeName: string,
        _limit: number,
        _scope: string | undefined,
        lookupOptions: { hydrate?: boolean }
      ) => {
        hydrate = lookupOptions.hydrate;
        return [implementation];
      }
    } as never,
    routingPolicy: resolveRoutingPolicy("/repo")
  });

  assert.equal(hydrate, true);
  assert.deepEqual(implementations, [implementation]);
  assert.ok(candidates.has(implementation.absolutePath));
  assert.deepEqual(candidates.get(implementation.absolutePath)?.positions, [{ line: 77, column: 1 }]);
});

test("type graph uses the unique caller-site callee when the implementer has no methodName", async () => {
  const candidates = new Map<string, CandidateFile>();
  const deleteAnchor: ResolvedAnchor = {
    ...anchor,
    absolutePath: "/repo/src/main/java/demo/CheckController.java",
    path: "src/main/java/demo/CheckController.java",
    line: 62,
    symbolName: "delete",
    methodName: "delete",
    className: "PositionCheckPeopleService",
    profile: "service"
  };
  const deleteImpl: JavaSourceFacts = {
    ...implementation,
    methods: [
      { name: "page", line: 69, endLine: 80, referencedTypes: [], relations: [] },
      { name: "deleteCheckPeople", line: 172, endLine: 189, referencedTypes: [], relations: [] }
    ]
  };
  await collectTypeGraphCandidates({
    candidates,
    anchors: [deleteAnchor],
    options,
    javaIndex: {
      factsFor: async () => ({
        ...implementation,
        absolutePath: deleteAnchor.absolutePath,
        kind: "interface",
        methods: [{
          name: "delete",
          line: 62,
          endLine: 66,
          referencedTypes: [],
          relations: [
            {
              kind: "local-receiver",
              typeName: "PositionCheckPeopleService",
              name: "deleteCheckPeople",
              line: 64,
              confidence: "medium",
              source: "ast"
            },
            {
              kind: "local-receiver",
              typeName: "CommonResult",
              name: "success",
              line: 65,
              confidence: "medium",
              source: "ast"
            }
          ]
        }]
      }),
      findImplementers: async () => [deleteImpl]
    } as never,
    routingPolicy: resolveRoutingPolicy("/repo")
  });

  assert.deepEqual(candidates.get(deleteImpl.absolutePath)?.positions, [{ line: 172, column: 1 }]);
});

test("type graph keeps only the @Primary implementer when several alternatives exist", async () => {
  const candidates = new Map<string, CandidateFile>();
  const primary = {
    ...implementation,
    annotations: ["Service", "Primary"]
  };
  const other = {
    ...implementation,
    absolutePath: "/repo/src/main/java/demo/OtherPortImpl.java",
    path: "src/main/java/demo/OtherPortImpl.java",
    annotations: ["Service"]
  };
  const implementations = await collectTypeGraphCandidates({
    candidates,
    anchors: [anchor],
    options,
    javaIndex: {
      factsFor: async () => ({ ...implementation, absolutePath: anchor.absolutePath, kind: "interface" }),
      findImplementers: async () => [other, primary]
    } as never,
    routingPolicy: resolveRoutingPolicy("/repo")
  });

  assert.deepEqual(implementations.map(item => item.absolutePath), [primary.absolutePath]);
  assert.equal(candidates.has(primary.absolutePath), true);
  assert.equal(candidates.has(other.absolutePath), false);
});
