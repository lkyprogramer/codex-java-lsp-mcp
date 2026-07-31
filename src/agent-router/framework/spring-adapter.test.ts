// input: fixtures/framework-spring - a real, checked-in Spring-flavored fixture repo (indexed by a
//         real worker, never hand-assembled facts).
// output: First, a guard that the raw FrameworkIndexView facts the Spring rules depend on are actually
//         present (a wrong assumption here would cost the whole slice, not one rule) - then the rules
//         themselves.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedAnchor } from "../../agent-types.js";
import { RouterJavaIndex } from "../../java-index/router-java-index.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { FrameworkAdapterContext } from "./adapter.js";
import type { CandidateEvidence } from "../evidence.js";
import { runFrameworkAdapters } from "./runner.js";
import { mybatisAdapter } from "./mybatis-adapter.js";
import { springAdapter } from "./spring-adapter.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "framework-spring");

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouterAt(root: string): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "spring-fixture-cache-"));
  const router = RouterJavaIndex.create(root, cacheDir);
  await router.open(1);
  await router.reconcile(1);
  await waitFor(async () => (await router.status()).pendingBackground === 0, 15_000);
  return router;
}

async function readyRouter(): Promise<RouterJavaIndex> {
  return readyRouterAt(repoRoot);
}

function file(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function anchor(absolutePath: string, overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1", absolutePath, line: 1, column: 1, profile: "service", symbolName: "Anchor", kind: "class",
    ...overrides
  };
}

async function frameworkContextFor(
  router: RouterJavaIndex,
  repo: string,
  anchors: readonly ResolvedAnchor[],
  candidateFiles: readonly string[]
): Promise<FrameworkAdapterContext> {
  return {
    repoRoot: repo,
    anchors,
    candidateFiles,
    staticEvidence: candidateFiles.map(candidate => ({
      file: candidate,
      signals: [],
      familyScores: { STATIC_STRUCTURE: 1 },
      finalScore: 1,
      confidence: "medium",
      degradation: []
    } satisfies CandidateEvidence)),
    frameworkIndex: router,
    generation: 1,
    budget: DeadlineBudget.fromTimeout(5_000)
  };
}

test("fixture facts: OrderController/OrderService/OrderRepository carry resolved Spring annotation FQNs", async () => {
  const router = await readyRouter();
  try {
    const controller = await router.frameworkFactsFor(file("src/main/java/demo/OrderController.java"));
    const controllerType = controller.types.find(t => t.simpleName === "OrderController")!;
    assert.deepEqual(
      controllerType.annotations.map(a => a.resolvedFqn).sort(),
      ["org.springframework.web.bind.annotation.RequestMapping", "org.springframework.web.bind.annotation.RestController"].sort()
    );
    const createMethod = controller.methods.find(m => m.name === "create")!;
    assert.deepEqual(createMethod.annotations.map(a => a.resolvedFqn), ["org.springframework.web.bind.annotation.PostMapping"]);
    assert.equal(createMethod.parameters[0]!.annotations[0]!.resolvedFqn, "org.springframework.web.bind.annotation.RequestBody");
    assert.equal(createMethod.parameters[0]!.type.resolvedFqn, "demo.OrderRequest");

    const service = await router.frameworkFactsFor(file("src/main/java/demo/OrderService.java"));
    const serviceType = service.types.find(t => t.simpleName === "OrderService")!;
    assert.deepEqual(serviceType.annotations.map(a => a.resolvedFqn), ["org.springframework.stereotype.Service"]);
    const ctor = service.methods.find(m => m.constructor)!;
    assert.equal(ctor.parameters.length, 2);
    assert.equal(ctor.parameters[0]!.type.resolvedFqn, "demo.OrderRepository");
    // ApplicationEventPublisher is a Spring framework type, not defined in this
    // fixture repo - it must resolve EXTERNAL, not RESOLVED_REPO, and the
    // injection rule must not require a repo-resolved FQN to detect it.
    assert.equal(ctor.parameters[1]!.type.resolvedFqn, "org.springframework.context.ApplicationEventPublisher");
    const createServiceMethod = service.methods.find(m => m.name === "create")!;
    assert.deepEqual(createServiceMethod.annotations.map(a => a.resolvedFqn), ["org.springframework.transaction.annotation.Transactional"]);

    const repository = await router.frameworkFactsFor(file("src/main/java/demo/OrderRepository.java"));
    const repositoryType = repository.types.find(t => t.simpleName === "OrderRepository")!;
    assert.deepEqual(repositoryType.annotations.map(a => a.resolvedFqn), ["org.springframework.stereotype.Repository"]);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect does not expand a lexical-only Spring candidate", async () => {
  const router = await readyRouter();
  try {
    const domain = file("src/main/java/demo/Order.java");
    const controller = file("src/main/java/demo/OrderController.java");
    const base = await frameworkContextFor(router, repoRoot, [anchor(domain)], [domain, controller]);
    const result = await springAdapter.collect({
      ...base,
      staticEvidence: base.staticEvidence.filter(candidate => candidate.file === domain)
    });

    assert.deepEqual(
      result.outcome.evidence,
      [],
      "a controller found only through lexical recall must not create an unrelated framework traversal"
    );
  } finally {
    await router.close();
  }
});

test("springAdapter.collect confines method-level endpoint evidence to the anchored method", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-method-scope-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.springframework.boot</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/demo/FirstRequest.java", "package demo; class FirstRequest {}\n");
  write(root, "src/main/java/demo/FirstResponse.java", "package demo; class FirstResponse {}\n");
  write(root, "src/main/java/demo/SecondRequest.java", "package demo; class SecondRequest {}\n");
  write(root, "src/main/java/demo/SecondResponse.java", "package demo; class SecondResponse {}\n");
  write(
    root,
    "src/main/java/demo/ScopedController.java",
    [
      "package demo;",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RequestBody;",
      "import org.springframework.web.bind.annotation.RestController;",
      "@RestController class ScopedController {",
      "  @PostMapping FirstResponse first(@RequestBody FirstRequest request) { return null; }",
      "  @PostMapping SecondResponse second(@RequestBody SecondRequest request) { return null; }",
      "}"
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/ScopedController.java");
    const result = await springAdapter.collect(await frameworkContextFor(
      router,
      root,
      [anchor(source, { line: 6, column: 26, kind: "Method", methodName: "first" })],
      [source]
    ));
    const targets = result.outcome.evidence.map(signal => signal.candidateFile).sort();

    assert.deepEqual(targets, [
      path.join(root, "src/main/java/demo/FirstRequest.java"),
      path.join(root, "src/main/java/demo/FirstResponse.java")
    ]);
    assert.equal((result.metadata as { endpoints?: unknown[] }).endpoints?.length, 1);
  } finally {
    await router.close();
  }
});

test("fixture facts: OrderService.create's publish call site and OrderListener.on's parameter both resolve to demo.OrderCreated", async () => {
  const router = await readyRouter();
  try {
    const service = await router.frameworkFactsFor(file("src/main/java/demo/OrderService.java"));
    const createMethod = service.methods.find(m => m.name === "create")!;
    const publishCall = createMethod.callSites.find(c => c.name === "publishEvent")!;
    assert.equal(publishCall.arity, 1);
    assert.equal(publishCall.argumentTypeHints[0]!.resolvedFqn, "demo.OrderCreated");

    const listener = await router.frameworkFactsFor(file("src/main/java/demo/OrderListener.java"));
    const listenerType = listener.types.find(t => t.simpleName === "OrderListener")!;
    assert.deepEqual(listenerType.annotations.map(a => a.resolvedFqn), ["org.springframework.stereotype.Component"]);
    const onMethod = listener.methods.find(m => m.name === "on")!;
    assert.deepEqual(onMethod.annotations.map(a => a.resolvedFqn), ["org.springframework.context.event.EventListener"]);
    assert.equal(onMethod.parameters[0]!.type.resolvedFqn, "demo.OrderCreated");
  } finally {
    await router.close();
  }
});

test("fixture facts: OrderController.create resolves a unique CALLS edge to OrderService.create via resolvedCallees", async () => {
  const router = await readyRouter();
  try {
    const controller = await router.frameworkFactsFor(file("src/main/java/demo/OrderController.java"));
    const createMethod = controller.methods.find(m => m.name === "create")!;

    const { callees, truncated } = await router.resolvedCallees(createMethod.methodId, 80);
    const callsEdges = callees.filter(c => c.kind === "CALLS");
    assert.equal(truncated, false);
    assert.equal(callsEdges.length, 1, "OrderController.create must resolve exactly one CALLS edge");
    assert.equal(callsEdges[0]!.targetId, "method:type:demo.OrderService#create(OrderRequest)");

    const declarations = await router.declarationsById([callsEdges[0]!.targetId]);
    assert.equal(declarations.methods[0]!.name, "create");
    assert.equal(declarations.methods[0]!.ownerTypeId, "type:demo.OrderService");
  } finally {
    await router.close();
  }
});

test("repositoryMarkers detects the Spring dependency declared in the fixture's pom.xml", async () => {
  const router = await readyRouter();
  try {
    const markers = await router.repositoryMarkers(["pom.xml"]);
    assert.match(markers.get("pom.xml") ?? "", /org\.springframework/);
  } finally {
    await router.close();
  }
});

test("springAdapter.isActive is true for the Spring fixture (pom.xml dependency) and false for a plain Java repo", async () => {
  const springRouter = await readyRouter();
  try {
    const active = await springAdapter.isActive(
      await frameworkContextFor(springRouter, repoRoot, [anchor(file("src/main/java/demo/OrderController.java"))], [])
    );
    assert.equal(active, true);
  } finally {
    await springRouter.close();
  }

  const plainRoot = mkdtempSync(path.join(tmpdir(), "spring-adapter-plain-repo-"));
  write(plainRoot, "src/main/java/demo/PlainService.java", "package demo;\nclass PlainService {}\n");
  const plainRouter = await readyRouterAt(plainRoot);
  try {
    const active = await springAdapter.isActive(
      await frameworkContextFor(plainRouter, plainRoot, [anchor(path.join(plainRoot, "src/main/java/demo/PlainService.java"))], [])
    );
    assert.equal(active, false, "a class named ...Service with no Spring annotation or dependency must not activate the adapter");
  } finally {
    await plainRouter.close();
  }
});

test("springAdapter.isActive probes the source module's build marker, not only the aggregator root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-module-detection-"));
  write(root, "pom.xml", "<project><modules><module>orders</module></modules></project>");
  write(root, "orders/pom.xml", "<project><dependency><groupId>org.springframework</groupId></dependency></project>");
  write(root, "orders/src/main/java/demo/OrderService.java", "package demo;\nclass OrderService {}\n");
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "orders/src/main/java/demo/OrderService.java");
    assert.equal(
      await springAdapter.isActive(await frameworkContextFor(router, root, [anchor(source)], [source])),
      true
    );
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits SPRING_INJECTION for OrderController->OrderService and OrderService->OrderRepository, but not for the external ApplicationEventPublisher parameter", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [
      file("src/main/java/demo/OrderController.java"),
      file("src/main/java/demo/OrderService.java")
    ];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const result = await springAdapter.collect(context);
    const injections = result.outcome.evidence.filter(s => s.kind === "SPRING_INJECTION");

    const byTarget = new Map(injections.map(s => [s.candidateFile, s]));
    const toService = byTarget.get(file("src/main/java/demo/OrderService.java"));
    assert.ok(toService, "OrderController's constructor injects OrderService");
    assert.equal(toService!.kind, "SPRING_INJECTION");
    assert.equal(toService!.family, "FRAMEWORK");
    assert.equal(toService!.weight, 90);
    assert.equal(toService!.confidence, 0.97);
    assert.equal(toService!.sourceFile, file("src/main/java/demo/OrderController.java"));

    const toRepository = byTarget.get(file("src/main/java/demo/OrderRepository.java"));
    assert.ok(toRepository, "OrderService's constructor injects OrderRepository");
    assert.equal(toRepository!.sourceFile, file("src/main/java/demo/OrderService.java"));

    // ApplicationEventPublisher is Spring's own external type - no repo file
    // exists to recommend, so it must not produce a broken/guessed signal.
    assert.equal(injections.length, 2, "exactly the two repo-resolved injection targets, nothing for the external publisher");
    assert.equal(result.outcome.completion, "COMPLETE");
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits SPRING_CALL_PATH for every invocation whose receiver is a confirmed injection target", async () => {
  const router = await readyRouter();
  try {
    const controller = await router.frameworkFactsFor(file("src/main/java/demo/OrderController.java"));
    const createMethod = controller.methods.find(m => m.name === "create")!;
    const { callees: expectedCallees } = await router.resolvedCallees(createMethod.methodId, 80);
    const expectedConfidence = expectedCallees.find(c => c.kind === "CALLS")!.confidence;

    const candidateFiles = [
      file("src/main/java/demo/OrderController.java"),
      file("src/main/java/demo/OrderService.java")
    ];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const result = await springAdapter.collect(context);
    const callPaths = result.outcome.evidence.filter(s => s.kind === "SPRING_CALL_PATH");

    assert.deepEqual(
      new Set(callPaths.map(signal => `${signal.sourceFile}->${signal.candidateFile}`)),
      new Set([
        `${file("src/main/java/demo/OrderController.java")}->${file("src/main/java/demo/OrderService.java")}`,
        `${file("src/main/java/demo/OrderService.java")}->${file("src/main/java/demo/OrderRepository.java")}`
      ])
    );
    assert.ok(callPaths.every(signal => signal.family === "FRAMEWORK" && signal.weight === 100));
    assert.ok(callPaths.some(signal => signal.confidence === expectedConfidence), "confidence must come from the matching CALLS edge, not an invented number");
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits SPRING_REQUEST_BODY (OrderController.create -> OrderRequest) and SPRING_RESPONSE_TYPE (OrderController.create -> OrderResponse)", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [file("src/main/java/demo/OrderController.java")];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const result = await springAdapter.collect(context);

    const requestBody = result.outcome.evidence.find(s => s.kind === "SPRING_REQUEST_BODY");
    assert.ok(requestBody);
    assert.equal(requestBody!.candidateFile, file("src/main/java/demo/OrderRequest.java"));
    assert.equal(requestBody!.sourceFile, file("src/main/java/demo/OrderController.java"));
    assert.equal(requestBody!.weight, 70);

    const responseType = result.outcome.evidence.find(s => s.kind === "SPRING_RESPONSE_TYPE");
    assert.ok(responseType);
    assert.equal(responseType!.candidateFile, file("src/main/java/demo/OrderResponse.java"));
    assert.equal(responseType!.weight, 70);

    assert.deepEqual(result.metadata, {
      endpoints: [{ methodId: (await router.frameworkFactsFor(candidateFiles[0]!)).methods.find(m => m.name === "create")!.methodId, httpMethods: ["POST"], paths: ["/orders"] }],
      transactionalMethodIds: []
    });
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits SPRING_PUBLISHES_EVENT (OrderService.create -> OrderCreated) and SPRING_CONSUMES_EVENT (OrderListener.on -> OrderCreated), merged onto one candidate", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [
      file("src/main/java/demo/OrderService.java"),
      file("src/main/java/demo/OrderListener.java")
    ];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const result = await springAdapter.collect(context);

    const publishes = result.outcome.evidence.find(s => s.kind === "SPRING_PUBLISHES_EVENT");
    assert.ok(publishes);
    assert.equal(publishes!.sourceFile, file("src/main/java/demo/OrderService.java"));
    assert.equal(publishes!.candidateFile, file("src/main/java/demo/OrderCreated.java"));
    assert.equal(publishes!.weight, 85);

    const consumes = result.outcome.evidence.find(s => s.kind === "SPRING_CONSUMES_EVENT");
    assert.ok(consumes);
    assert.equal(consumes!.sourceFile, file("src/main/java/demo/OrderListener.java"));
    assert.equal(consumes!.candidateFile, file("src/main/java/demo/OrderCreated.java"));
    assert.equal(consumes!.weight, 85);

    const merged = result.outcome.candidates.find(c => c.absolutePath === file("src/main/java/demo/OrderCreated.java"));
    assert.ok(merged, "both edges point at the same event type, so they must merge into one candidate");
    assert.deepEqual(merged!.reasons.sort(), ["SPRING_CONSUMES_EVENT", "SPRING_PUBLISHES_EVENT"]);

    assert.deepEqual(result.metadata, {
      endpoints: [],
      transactionalMethodIds: [(await router.frameworkFactsFor(candidateFiles[0]!)).methods.find(m => m.name === "create")!.methodId]
    });
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits SPRING_BEAN_PRODUCES for a @Bean method's return type", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-bean-"));
  write(root, "src/main/java/demo/Client.java", "package demo;\nclass Client {}\n");
  write(
    root,
    "src/main/java/demo/AppConfig.java",
    [
      "package demo;",
      "",
      "import org.springframework.context.annotation.Bean;",
      "",
      "class AppConfig {",
      "  @Bean",
      "  Client client() { return new Client(); }",
      "}",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const candidateFile = path.join(root, "src/main/java/demo/AppConfig.java");
    const context = await frameworkContextFor(router, root, [anchor(candidateFile)], [candidateFile]);

    const result = await springAdapter.collect(context);
    const produces = result.outcome.evidence.find(s => s.kind === "SPRING_BEAN_PRODUCES");

    assert.ok(produces, "a @Bean method must produce evidence even though AppConfig itself carries no recognized stereotype annotation");
    assert.equal(produces!.candidateFile, path.join(root, "src/main/java/demo/Client.java"));
    assert.equal(produces!.weight, 75);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect chunks declarationsById past its 64-id-per-call cap instead of silently losing evidence targets beyond it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-many-targets-"));
  const TARGET_COUNT = 70; // > MAX_DECLARATION_IDS_PER_CALL (64) - the whole point of this test
  const candidateFiles: string[] = [];
  for (let i = 0; i < TARGET_COUNT; i++) {
    write(root, `src/main/java/demo/Dep${i}.java`, `package demo;\nclass Dep${i} {}\n`);
    const servicePath = `src/main/java/demo/Service${i}.java`;
    write(
      root,
      servicePath,
      [
        "package demo;",
        "",
        "import org.springframework.stereotype.Service;",
        "",
        "@Service",
        `class Service${i} {`,
        `  private final Dep${i} dep;`,
        `  Service${i}(Dep${i} dep) { this.dep = dep; }`,
        "}",
        ""
      ].join("\n")
    );
    candidateFiles.push(path.join(root, servicePath));
  }
  const router = await readyRouterAt(root);
  try {
    const context = await frameworkContextFor(router, root, [anchor(candidateFiles[0]!)], candidateFiles);

    const result = await springAdapter.collect(context);
    const injections = result.outcome.evidence.filter(s => s.kind === "SPRING_INJECTION");

    assert.equal(injections.length, TARGET_COUNT, "every one of the 70 distinct injection targets must resolve, not just the first 64");
    assert.equal(result.outcome.completion, "COMPLETE");
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect stops at an already-exhausted deadline instead of scanning any candidate file, and reports PARTIAL_TIMEOUT", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [
      file("src/main/java/demo/OrderController.java"),
      file("src/main/java/demo/OrderService.java")
    ];
    let clockCalls = 0;
    const expiredNow = () => (clockCalls++ === 0 ? 0 : 1_000_000); // first call is fromTimeout's own deadline computation; every call after is already past it
    const context: FrameworkAdapterContext = {
      ...(await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles)),
      budget: DeadlineBudget.fromTimeout(1, expiredNow)
    };

    const result = await springAdapter.collect(context);

    assert.deepEqual(result.outcome.evidence, [], "a budget that is already exhausted before the first file must not scan any candidate file");
    assert.equal(result.outcome.completion, "PARTIAL_TIMEOUT");
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0]!, /deadline exhausted/);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect produces no injection signal for a stereotype class with two constructors and none @Autowired (ambiguous)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-ambiguous-ctor-"));
  write(root, "src/main/java/demo/Dep.java", "package demo;\nclass Dep {}\n");
  write(
    root,
    "src/main/java/demo/AmbiguousService.java",
    [
      "package demo;",
      "",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "class AmbiguousService {",
      "  private final Dep dep;",
      "  AmbiguousService() { this.dep = null; }",
      "  AmbiguousService(Dep dep) { this.dep = dep; }",
      "}",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const candidateFile = path.join(root, "src/main/java/demo/AmbiguousService.java");
    const context = await frameworkContextFor(router, root, [anchor(candidateFile)], [candidateFile]);

    const result = await springAdapter.collect(context);

    assert.deepEqual(result.outcome.evidence, [], "two constructors with no @Autowired to disambiguate must not guess which one Spring would use");
  } finally {
    await router.close();
  }
});

test("springAdapter.collect produces no injection signal for a plain (non-stereotype) class, even with a Spring-shaped constructor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-non-stereotype-"));
  write(root, "src/main/java/demo/Dep.java", "package demo;\nclass Dep {}\n");
  write(
    root,
    "src/main/java/demo/PlainHolder.java",
    ["package demo;", "", "class PlainHolder {", "  private final Dep dep;", "  PlainHolder(Dep dep) { this.dep = dep; }", "}", ""].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const candidateFile = path.join(root, "src/main/java/demo/PlainHolder.java");
    const context = await frameworkContextFor(router, root, [anchor(candidateFile)], [candidateFile]);

    const result = await springAdapter.collect(context);

    assert.deepEqual(result.outcome.evidence, [], "a plain class's constructor is not Spring injection without a stereotype annotation");
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits a call path for an injected receiver even when the method also calls a local helper", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-injected-call-"));
  write(root, "src/main/java/demo/Service.java", "package demo;\nclass Service { void run() {} }\n");
  write(
    root,
    "src/main/java/demo/Controller.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Controller;",
      "@Controller class Controller {",
      "  private final Service service;",
      "  Controller(Service service) { this.service = service; }",
      "  void handle() { service.run(); audit(); }",
      "  void audit() {}",
      "}",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/Controller.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(source)], [source]));
    assert.deepEqual(
      result.outcome.evidence.filter(signal => signal.kind === "SPRING_CALL_PATH").map(signal => signal.candidateFile),
      [path.join(root, "src/main/java/demo/Service.java")]
    );
  } finally {
    await router.close();
  }
});

test("springAdapter.collect does not label a component's non-injected helper call as a Spring call path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-helper-call-"));
  write(
    root,
    "src/main/java/demo/Controller.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Controller;",
      "@Controller class Controller {",
      "  void handle() { helper(); }",
      "  void helper() {}",
      "}",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/Controller.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(source)], [source]));
    assert.deepEqual(result.outcome.evidence.filter(signal => signal.kind === "SPRING_CALL_PATH"), []);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect binds a call path only to this component's plain or this-qualified injection receiver", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-receiver-identity-"));
  write(root, "src/main/java/demo/OrderService.java", "package demo;\nclass OrderService { void run() {} }\n");
  write(
    root,
    "src/main/java/demo/Handler.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "@Service",
      "class Handler {",
      "  private final OrderService service;",
      "  private final Other other;",
      "  Handler(OrderService service, Other other) { this.service = service; this.other = other; }",
      "  void run() { other.service.run(); }",
      "}",
      "class Other { OrderService service; }",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/Handler.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(source)], [source]));

    assert.deepEqual(
      result.outcome.evidence.filter(signal => signal.kind === "SPRING_CALL_PATH"),
      [],
      "other.service is not Handler's injected service field, even though its declared type happens to match"
    );
  } finally {
    await router.close();
  }
});

test("springAdapter.collect requires an injected ApplicationEventPublisher receiver before emitting an event", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-custom-publisher-"));
  write(root, "src/main/java/demo/Created.java", "package demo;\nclass Created {}\n");
  write(root, "src/main/java/demo/CustomPublisher.java", "package demo;\nclass CustomPublisher { void publishEvent(Created event) {} }\n");
  write(
    root,
    "src/main/java/demo/Service.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "@Service class Service {",
      "  private final CustomPublisher publisher;",
      "  Service(CustomPublisher publisher) { this.publisher = publisher; }",
      "  void run() { publisher.publishEvent(new Created()); }",
      "}",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/Service.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(source)], [source]));
    assert.deepEqual(result.outcome.evidence.filter(signal => signal.kind === "SPRING_PUBLISHES_EVENT"), []);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect discovers an event listener outside the initial candidate set", async () => {
  const router = await readyRouter();
  try {
    const service = file("src/main/java/demo/OrderService.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, repoRoot, [anchor(service)], [service]));
    assert.ok(
      result.outcome.evidence.some(signal => signal.candidateFile === file("src/main/java/demo/OrderListener.java")),
      "publishing an event must surface its listener even when upstream providers did not nominate that file"
    );
  } finally {
    await router.close();
  }
});

test("springAdapter.collect retains a wildcard-imported listener discovered outside the initial candidate set", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-wildcard-listener-"));
  write(root, "pom.xml", "<project><dependency><groupId>org.springframework</groupId></dependency></project>");
  write(root, "src/main/java/demo/Created.java", "package demo;\nclass Created {}\n");
  write(
    root,
    "src/main/java/demo/Publisher.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "import org.springframework.context.ApplicationEventPublisher;",
      "@Service class Publisher {",
      "  private final ApplicationEventPublisher publisher;",
      "  Publisher(ApplicationEventPublisher publisher) { this.publisher = publisher; }",
      "  void publish() { publisher.publishEvent(new Created()); }",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/main/java/demo/CreatedListener.java",
    [
      "package demo;",
      "import org.springframework.context.event.*;",
      "class CreatedListener { @EventListener void on(Created event) {} }",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const publisher = path.join(root, "src/main/java/demo/Publisher.java");
    const listener = path.join(root, "src/main/java/demo/CreatedListener.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(publisher)], [publisher]));

    assert.ok(
      result.outcome.evidence.some(signal => signal.kind === "SPRING_EVENT_LISTENER" && signal.candidateFile === listener),
      "reverse discovery must preserve a COMPLETE wildcard-imported @EventListener rather than treating it as absent"
    );
  } finally {
    await router.close();
  }
});

test("springAdapter.collect emits request/response evidence only for mapped controller methods", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-request-body-scope-"));
  write(root, "src/main/java/demo/Payload.java", "package demo;\nclass Payload {}\n");
  write(
    root,
    "src/main/java/demo/Service.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "import org.springframework.web.bind.annotation.RequestBody;",
      "@Service class Service { void consume(@RequestBody Payload payload) {} }",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/Service.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(source)], [source]));
    assert.deepEqual(result.outcome.evidence.filter(signal => signal.kind === "SPRING_REQUEST_BODY" || signal.kind === "SPRING_RESPONSE_TYPE"), []);
  } finally {
    await router.close();
  }
});

test("springAdapter.collect records type-level transaction methods as metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spring-adapter-type-transaction-"));
  write(
    root,
    "src/main/java/demo/Service.java",
    [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "import org.springframework.transaction.annotation.Transactional;",
      "@Service @Transactional class Service { void run() {} }",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const source = path.join(root, "src/main/java/demo/Service.java");
    const result = await springAdapter.collect(await frameworkContextFor(router, root, [anchor(source)], [source]));
    const methodId = (await router.frameworkFactsFor(source)).methods.find(method => method.name === "run")!.methodId;
    assert.deepEqual((result.metadata as { transactionalMethodIds: string[] }).transactionalMethodIds, [methodId]);
  } finally {
    await router.close();
  }
});

test("running springAdapter through runFrameworkAdapters against the real fixture yields the same evidence as a direct collect() call", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [file("src/main/java/demo/OrderController.java"), file("src/main/java/demo/OrderService.java")];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const directResult = await springAdapter.collect(context);
    const runResult = await runFrameworkAdapters([springAdapter], context);

    assert.equal(runResult.outcome.providerId, "framework");
    assert.deepEqual(runResult.outcome.evidence, directResult.outcome.evidence);
    assert.ok(runResult.outcome.evidence.length > 1, "the full rule set (injection, call path, request body, response type, publishes event) must all be present, not just one kind");
    assert.deepEqual(new Set(runResult.outcome.evidence.map(s => s.kind)), new Set(["SPRING_INJECTION", "SPRING_CALL_PATH", "SPRING_REQUEST_BODY", "SPRING_RESPONSE_TYPE", "SPRING_PUBLISHES_EVENT", "SPRING_EVENT_LISTENER"]));
    assert.deepEqual(runResult.diagnostics, []);
  } finally {
    await router.close();
  }
});

test("registering mybatisAdapter alongside springAdapter does not change Spring's evidence on a MyBatis-inactive fixture", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [file("src/main/java/demo/OrderController.java"), file("src/main/java/demo/OrderService.java")];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const springOnly = await runFrameworkAdapters([springAdapter], context);
    const combined = await runFrameworkAdapters([springAdapter, mybatisAdapter], context);

    assert.deepEqual(combined.outcome.evidence, springOnly.outcome.evidence);
    assert.deepEqual(combined.outcome.candidates, springOnly.outcome.candidates);
    assert.equal(combined.metadata.mybatis, undefined, "mybatisAdapter must not activate on the Spring fixture (no MyBatis build marker or import/annotation)");
  } finally {
    await router.close();
  }
});
