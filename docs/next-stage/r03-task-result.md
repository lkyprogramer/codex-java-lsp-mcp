# R03 — 中性对称工具与每次修复一致工作区

**Status**: GREEN

{
  "schema": "java-specialist-r03-task-result/v1",
  "status": "GREEN",
  "date": "2026-10-02",
  "source_head": "ee3e774339c9064b62bb40af48701224243adb09",
  "red": {
    "command": "python tools/run_audit.py --project $RUNS/r03-b9 --output $RUNS/r03-red --cases W05",
    "baseline": "b9c3cc3 clean worktree",
    "result": "1/1 FAIL",
    "run_json_sha256": "31b47b2b70df282de0c73e6e6b6064f8b4720f7f36e67ee6fd9ee49304c61b3b"
  },
  "green": {
    "command": "python tools/run_audit.py --project $PROJECT --output $RUNS/r03-green --cases W05",
    "result": "1/1 PASS",
    "run_json_sha256": "476b1ca77736a6f74c9dca3db9338168b63d0b61b591f516098052fe1c705055",
    "selfcheck_summary_sha256": "5f6f4cb1412546249221239568a57fa3dbb176a8a209d266967e466d56dcbc02",
    "regression": {
      "unit_tests": "63/63 (eval-native-tools 5 + evaluate-java-task 10 + eval-frozen-adapter 13 + run-agent-trace-live 27 + eval-tool-wire 8)",
      "probe": "12/12",
      "kit_selfcheck": "5/5",
      "isolated_validation_full": "1199 + 322 PASS, 0 FAIL"
    }
  },
  "mechanism": {
    "symmetric_native_tools": "buildToolSet(profile, kind, {candidateRoot}) in scripts/eval-native-tools.mjs: both arms get list/rg/read (repair kind adds write_file); the ONLY arm difference is the product arm's java_symbol. EVAL_SYSTEM_PROMPT updated to state the shared surface (W05).",
    "per_attempt_workspace": "createAttemptWorkspace(fixtureRoot, attemptKey, outputRoot) copies the fixture (minus .git) to a unique candidates/<key> root per arm x repeat; all host tools for the attempt operate on that one candidate root (single read/write root).",
    "canonical_containment": "resolveInCandidate: separator normalization (Windows backslashes), path.isAbsolute rejection, path.relative logical containment for all targets (incl. non-existent write targets), realpath containment for existing targets (symlink escape). No startsWith anywhere.",
    "session_rebind": "after a write in an attempt, the MCP session is rebound to the candidate root (fresh cache) so the next java_symbol query observes the modification; the fixture session is reopened for subsequent repeats. Sessions are closed per attempt (no leaks).",
    "rg_execution": "argv-array spawn (pattern is one argument, never shell-joined), bounded stdout (output cap kills the child), timeout, missing binary => BLOCKED_ENV error object."
  },
  "boundary_tests": [
    "prefix-sibling directory (fixture-evil) rejected via relative containment",
    "symlink inside workspace pointing outside rejected via realpath",
    "Windows backslash separators normalize; ..\\ escapes rejected",
    "absolute paths rejected (must be repo-relative)",
    "missing file returns structured {error}, never throws",
    "distinct candidate roots per attempt; fixture stays pristine after a sibling attempt's write",
    "write confined to candidate; write then re-read observes the modification"
  ],
  "also_touched": {
    "evaluate-java-task.mjs": "runLiveEvalRun now creates a per-attempt candidate workspace, binds both arms to buildToolSet (product adds EVAL_JAVA_SYMBOL_TOOL), passes real SOURCE_RECEIVED rows into scoring, and rebonding the MCP session onto the candidate after a write_file.",
    "agent-ab.mjs (experiment, not a product dependency)": "per-attempt session + candidate rebind after write; startsWith path check replaced by resolveInCandidate; per-attempt session close."
  },
  "remaining_gaps": [
    "scripted agent read->write->frozen-test end-to-end (R04 judge reuse + R12 real-SDK transport); mechanism-level read->write->re-observe is covered by eval-native-tools.test.mjs",
    "four-arm live experiment remains NOT_RUN (R10/R12); no model validity claims are made by this task"
  ]
}
