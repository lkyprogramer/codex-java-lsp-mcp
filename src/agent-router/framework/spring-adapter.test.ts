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
import { runFrameworkAdapters } from "./runner.js";
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

test("springAdapter.collect emits SPRING_INJECTION for OrderController->OrderService and OrderService->OrderRepository, but not for the external ApplicationEventPublisher parameter", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [
      file("src/main/java/demo/OrderController.java"),
      file("src/main/java/demo/OrderService.java")
    ];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const result = await springAdapter.collect(context);

    const byTarget = new Map(result.outcome.evidence.map(s => [s.candidateFile, s]));
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
    assert.equal(result.outcome.evidence.length, 2, "exactly the two repo-resolved injection targets, nothing for the external publisher");
    assert.equal(result.outcome.completion, "COMPLETE");

    const candidatePaths = result.outcome.candidates.map(c => c.absolutePath).sort();
    assert.deepEqual(candidatePaths, [file("src/main/java/demo/OrderRepository.java"), file("src/main/java/demo/OrderService.java")].sort());
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

test("running springAdapter through runFrameworkAdapters against the real fixture yields the same SPRING_INJECTION evidence as a direct collect() call", async () => {
  const router = await readyRouter();
  try {
    const candidateFiles = [file("src/main/java/demo/OrderController.java"), file("src/main/java/demo/OrderService.java")];
    const context = await frameworkContextFor(router, repoRoot, [anchor(candidateFiles[0]!)], candidateFiles);

    const runResult = await runFrameworkAdapters([springAdapter], context);

    assert.equal(runResult.outcome.providerId, "framework");
    assert.equal(runResult.outcome.evidence.length, 2);
    assert.ok(runResult.outcome.evidence.every(s => s.kind === "SPRING_INJECTION"));
    assert.deepEqual(runResult.diagnostics, []);
  } finally {
    await router.close();
  }
});
