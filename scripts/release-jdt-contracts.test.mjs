import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertReferenceOracle, assertSharedOracle, fixtureSources, prepareFixture } from './release-jdt-contracts.mjs';

const complete = {
  shortCode: 'DEADLINE_EXCEEDED', whileShortExited: { inflight: 1, sharedJoins: 1, abortedNoWaiters: 0 },
  longOutcome: { completion: 'COMPLETE' }, settled: { inflight: 0, completeWrites: 1, abortedNoWaiters: 0 }, backendCalls: 1
};
test('K28 oracle rejects successful summaries without actual waiter isolation', () => {
  assertSharedOracle(complete);
  for (const wrong of [
    { ...complete, shortCode: undefined }, { ...complete, backendCalls: 2 },
    { ...complete, whileShortExited: { ...complete.whileShortExited, inflight: 0 } },
    { ...complete, whileShortExited: { ...complete.whileShortExited, abortedNoWaiters: 1 } },
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
