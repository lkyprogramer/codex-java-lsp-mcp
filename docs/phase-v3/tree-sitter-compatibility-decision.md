# Tree-sitter Compatibility Decision

- Node: v22.16.0
- macOS/arch: darwin arm64
- selected backend: native (`tree-sitter` npm package, N-API/C++ addon)
- package versions: `tree-sitter@0.25.0`, `tree-sitter-java@0.23.5`
- install command: `npm install` (no flags), with a scoped `package.json` override:
  ```json
  "overrides": { "tree-sitter-java": { "tree-sitter": "0.25.0" } }
  ```
- worker smoke result: PASS — `src/java-index/tree-sitter-smoke.test.js`, native addon loads and parses correctly inside a `worker_threads.Worker` (the actual risk this task exists to check; see 架构策略 §19.1)
- full parse result: PASS — root type `program`, `hasError === false`, tree text contains `method_declaration` and `record_declaration`
- incremental `Tree.edit` result: PASS — see "changed-ranges result" for the edit-scenario correction
- changed-ranges result: PASS with a corrected edit scenario, plus a load-bearing finding:
  - `getChangedRanges` only reports ranges where tree **structure** differs, not where node **text** differs. A same-node-type leaf substitution (e.g. renaming a `type_identifier` to another `type_identifier`, such as the plan's original `String` → `Object` smoke edit) is structurally identical and correctly returns zero ranges — confirmed empirically (4 independent cases: same-length identifier swap, shrinking identifier swap, string-literal content swap, record-component rename all returned `0`; a swap that changes tree shape, e.g. `String` → `java.lang.String`/`java.lang.Object`, returned `1`) and is documented upstream behavior ([tree-sitter/tree-sitter discussion #2057](https://github.com/tree-sitter/tree-sitter/discussions/2057)).
  - The smoke worker's edit scenario was changed from a `String`→`Object` leaf swap to inserting a `final ` modifier before `String text` (a genuine structural insertion: adds a `modifiers` child to the existing `local_variable_declaration`). This correctly yields `changedRanges.length === 1` and lets `incrementalTypeText` (found via a `type_identifier` DFS search) assert `"String"` — proving the incremental reparse recomputed byte offsets correctly after a 6-byte insertion shifted everything to its right.
- Tree resource release result: no JS-level `delete()` exists on this native binding, on any version tested. Confirmed by:
  - runtime probe: `typeof tree.delete === "undefined"` on both `tree` and the reparsed tree;
  - type declarations: `tree-sitter.d.ts` does not declare `delete` on `Tree` at all (the plan's `tree.delete?.()` call did not even type-check against the untouched interface and needed an explicit untyped view to compile);
  - source inspection: `node_modules/tree-sitter/src/tree.cc` registers exactly nine `InstanceMethod`s (`edit`, `rootNode`, `rootNodeWithOffset`, `printDotGraph`, `getChangedRanges`, `getIncludedRanges`, `getEditedRange`, `_cacheNode`, `_cacheNodes`) — none is `delete`. The underlying C tree is freed via `ts_tree_delete(tree_)` inside the C++ destructor, invoked by the N-API finalizer when the JS `Tree` object is garbage collected.
  - This is unlike `web-tree-sitter` (WASM/Emscripten), which requires an explicit `delete()` because Emscripten heap objects are not covered by V8's garbage collector.
  - `src/java-index/tree-sitter-smoke.test.ts` asserts `result.supportsDelete === false` (not `true` as the plan originally specified) to pin this fact — if a future tree-sitter version adds a JS-level `delete()`, this assertion will fail and force a re-read of this doc.
  - `src/java-index/java-parser-backend.ts`'s `JavaSyntaxTree.delete()` is kept on the interface (required for a future WASM backend, where it must do real work) but is implemented as a documented no-op in the native adapter — not a dual runtime path, one implementation whose cleanup step happens to be redundant with the destructor.
- rejected backend and reason:
  - `web-tree-sitter` (WASM): not evaluated. Per Task 14 Step 5 and 架构策略 §19.1 ("native 失败才选择 WASM，不维护双路径"), WASM is only in scope if native fails to load/parse under Node 22 in a worker thread. It did not fail — the worker smoke test passed cleanly. No `vendor/tree-sitter-java/*.wasm` artifact was produced.
  - `tree-sitter@0.21.1` (the version `tree-sitter-java@0.23.5`'s stale optional peer-dependency metadata literally requests): installed and parsed correctly in an isolated scratch package with no peer conflict, but was rejected in favor of the plan-pinned `0.25.0` because 0.25.0 is the current release with presumably more Node-22/N-API/worker-thread hardening, and both versions are otherwise equivalent for this task's purposes. **Not** rejected for missing `Tree.delete()` — that reasoning was considered during this investigation and found to be wrong: neither version exposes `Tree.delete()` (see "Tree resource release result" above). `tree-sitter-java@0.23.5`'s `peerDependencies: { "tree-sitter": "^0.21.1" }` (`peerDependenciesMeta.tree-sitter.optional: true`) is stale metadata, not a real incompatibility with `0.25.0` — `npm view` confirms `0.25.0` and `0.23.5` are each package's current latest version. Resolved via a `package.json` `overrides` entry scoped to exactly this one pair, rather than a blanket `--legacy-peer-deps`/`.npmrc legacy-peer-deps=true`, which would silently relax peer checks for every future dependency Iteration C adds.

## Known limits carried into Task 15/16 (not fixed in this task)

- **Parse-tree LRU eviction (plan lines 5380/5416) assumed `Tree.delete()` deterministically frees memory on eviction.** Since no such method exists for the native backend, eviction can only drop the last JS reference and let V8's garbage collector run the N-API finalizer — which is non-deterministic. A bounded LRU by *entry count* does not bound native memory *at the point of eviction*; actual free may lag behind eviction by one or more GC cycles. Task 15's design should account for this (e.g. by not assuming eviction == immediate memory relief) rather than being fixed here.
- **`getChangedRanges` will not report a renamed identifier/type/method as a changed range** when the rename keeps the same node type (the common case for a rename). Any Task 16+ incremental-extraction logic that scopes re-extraction to `getChangedRanges` output alone will silently miss pure renames. This needs either a full re-extraction per changed file (safe, simpler) or a separate text-diff-based signal layered on top of `getChangedRanges` — a decision for Task 16, not resolved here.

## Files produced

- `src/java-index/tree-sitter-smoke-worker.ts`
- `src/java-index/tree-sitter-smoke.test.ts`
- `src/java-index/java-parser-backend.ts`
- `src/java-index/java-parser-backend.test.ts`
- `package.json` (`overrides` entry; `tree-sitter`/`tree-sitter-java` dependencies)
- `package-lock.json`

No `vendor/tree-sitter-java/*` was created — the native decision needs no committed WASM grammar.
