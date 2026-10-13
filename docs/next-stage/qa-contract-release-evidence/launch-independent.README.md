# Independent locked runner

`launch-independent.mjs` is an external adapter of the frozen `launch-final.mjs` executor and original candidate evaluator. The runnable public dataset is exclusively `p5-independent-locked-v1-r2`; v1 is preserved history. It schedules 9 QA + 3 repair tasks, product/control once each (24 rows). Original public/P4 denominators remain separate.

Configuration: source `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`, 611 candidate files, `openclaw/Qwen3.8-next`, broad, default static reader 1, 2048 completion tokens, reasoning none/thinking false, 16 rounds, ordering seed 1984, no provider sampling seed, original QA source budget 160 lines/16000 bytes.

The runner reads only frozen public inputs. `prepare` and `drycheck` neither import owner callbacks nor read Pi credentials. It binds the public manifest/files/contract/tool schemas, candidate identity, protocol/evaluator/helper/executor/launcher hashes, opaque private owner seal/harness, and parent recorded independent review. Original P1/P2/P3, current engineering/default capacity, and owner public review gates must be PASS. No gate status is inferred.

At run time only, the isolated child imports the public owner interface. Before each block it checks public bindings and the synchronous opaque owner seal. Original `runLiveEvalRun` gets `gold:new Map()`, public kit/repo roots, and the owner judge callback with `outputRoot` mapped to `outputDir`. Per-slot original scoped scoring is delegated synchronously to owner score. Only original `frozen-kit` results matching the frozen public dataset hash are accepted. The results-pack dataset hash remains null until an accepted owner scorer result is observed. Pending QA rows remain UNMEASURED/null until that authority accepts them. Normal failed attempts and fatal missing rows keep all 24 planned keys. Raw requests/responses/receipts/usage and scored clones follow the original executor.

The owner r2 repair boundary keeps original private test/reference/staging/verdict inside its private runtime. The public judge artifact is a safe opaque receipt. Runner does not inspect private owner files. Scoring and private judgment semantics remain owned by the original frozen evaluator and independently reviewed owner interface.

Invocation, after parent records final owner/public and runner reviews:

```sh
node ROOT/launch-independent.mjs CANDIDATE prepare
node ROOT/launch-independent.mjs CANDIDATE drycheck
node ROOT/launch-independent.mjs CANDIDATE run
```

Actual prepare/drycheck/run/provider execution is NOT RUN by the adapter author. `run` alone uses existing Pi provider configuration in the parent and passes credentials only in isolated child environment; no auth files are copied or serialized. Stage/run destinations refuse overwrite.

Offline proof: `node --test ROOT/launch-independent.offline.test.mjs` passed final 5/5 in `launch-independent.offline-r5-final.tap`. It checks original empty-gold null behavior, 24-row plan, callback mapping, frozen scoring authority, opaque seal rejection, exact public file set, and failure denominators via the original executor. It uses fake owner/session data and performs no model request or private read. The final proof includes explicit broad-profile scorer forwarding and owner dataset identity mismatch rejection. Earlier proof logs remain preserved.

Copier adds exact v1 and v1-r2 public directory selectors only. `package-evidence.independent-selector-r2.tap` proves preservation of separate raw artifacts and rejection of an unselected owner directory with fake files. No actual collection/copy was run. Existing P4 completion guards and three-phase denominators are unchanged; P5 outcome/release authority remains the parent task's responsibility.
