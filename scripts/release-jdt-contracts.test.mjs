import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolationOracle, assertReferenceOracle, assertSharedOracle, fixtureSources, isolationSources, prepareFixture } from './release-jdt-contracts.mjs';

// Gateway counters are cumulative in the owner; the oracle judges deltas from the base read.
const base = { inflight: 0, sharedJoins: 3, abortedNoWaiters: 1, completeWrites: 7 };
const complete = {
  shortCode: 'DEADLINE_EXCEEDED', whileShortExited: { inflight: 1, sharedJoins: 4, abortedNoWaiters: 1, base },
  longOutcome: { completion: 'COMPLETE' }, settled: { inflight: 0, completeWrites: 8, abortedNoWaiters: 1 }
};
test('K28 oracle rejects successful summaries without actual waiter isolation', () => {
  assertSharedOracle(complete);
  for (const wrong of [
    { ...complete, shortCode: undefined }, { ...complete, settled: { ...complete.settled, completeWrites: 9 } },
    { ...complete, whileShortExited: { ...complete.whileShortExited, sharedJoins: 3 } },
    { ...complete, whileShortExited: { ...complete.whileShortExited, inflight: 0 } },
    { ...complete, whileShortExited: { ...complete.whileShortExited, abortedNoWaiters: 2 } },
    { ...complete, longOutcome: { completion: 'PARTIAL' } },
    { ...complete, settled: { ...complete.settled, inflight: 1 } }
  ]) assert.throws(() => assertSharedOracle(wrong));
});
test('real reference oracle requires exact caller selection', () => {
  const reference = position => ({ groups: [{ files: [{ path: 'src/main/java/probe/Caller.java', positions: [position] }] }] });
  assertReferenceOracle(reference({ line: 5, column: 23 }));
  assert.throws(() => assertReferenceOracle({ groups: [] }));
  assert.throws(() => assertReferenceOracle(reference({ line: 5, column: 22 })));
});
test('fixture is dependency-free Maven source with stable selection positions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-jdt-fixture-'));
  try {
    prepareFixture(root);
    for (const [file, source] of Object.entries(fixtureSources)) assert.equal(readFileSync(path.join(root, file), 'utf8'), source);
    assert.equal(fixtureSources['src/main/java/probe/Target.java'].split('\n')[4].slice(22, 29), 'compute');
    assert.equal(fixtureSources['src/main/java/probe/Caller.java'].split('\n')[4].slice(22, 29), 'compute');
    assert.ok(!fixtureSources['pom.xml'].includes('<dependencies>'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('same-URI isolation oracle requires each worktree to answer from its own content', () => {
  const a = { hover: 'static int compute(int value)' }, b = { hover: 'static int compute(long value)' };
  assertIsolationOracle({ a, b });
  assert.throws(() => assertIsolationOracle({ a, b: a }), 'worktree b answered with worktree a content');
  assert.throws(() => assertIsolationOracle({ a: b, b }));
  assert.throws(() => assertIsolationOracle({ a: { hover: a.hover + ' compute(long value)' }, b }));
  for (const file of Object.keys(isolationSources)) {
    assert.notEqual(isolationSources[file], fixtureSources[file]);
    assert.equal(isolationSources[file].split('\n')[4].slice(22, 29), 'compute', 'same selection position in both worktrees');
  }
});
