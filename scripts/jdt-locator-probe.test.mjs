import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runLocatorProbe } from './jdt-locator-probe.mjs';

const source = '@Deprecated\nclass Target {}\n';
const candidate = {
  declaration: { symbolId: 'jsym:mac1:workspace:dGFyZ2V0', name: 'Target', kind: 'class', relativePath: 'Target.java', selection: { line: 2, column: 7 } },
  evidenceRange: { relativePath: 'Target.java', contentHash: createHash('sha256').update(source).digest('hex'), startLine: 1, endLine: 2 },
  preview: source
};
const position = { hover: 'class Target', definitions: [{ path: 'Target.java', line: 2, column: 7 }] };
const run = call => runLocatorProbe({ repoRoot: '/fixture', queries: ['Target'], call, readSource: () => source, sleep: async () => {} });

test('uses verified head evidence and selection without declaration.range', async () => {
  const calls = [];
  const result = await run(async (name, args) => { calls.push(args); return args.operation ? position : { candidates: [candidate] }; });
  assert.equal(calls[0].preview, 'head');
  assert.equal(result.summary.selectionResolvesDeclaration, 1);
  assert.equal(result.rows[0].oldLocator.line, 1);
});

test('empty query candidates cannot pass', async () => {
  await assert.rejects(run(async () => ({ candidates: [] })), /no candidates/);
});

test('transport errors cannot pass or be retried into success', async () => {
  await assert.rejects(run(async (name, args) => args.operation ? { error: 'transport failed' } : { candidates: [candidate] }), /transport failed/);
});

test('hover naming a declaration cannot hide wrong definition binding', async () => {
  await assert.rejects(run(async (name, args) => args.operation ? { hover: 'class Target', definitions: [{ path: 'Other.java', line: 2, column: 7 }] } : { candidates: [candidate] }), /definition does not bind/);
});

test('same line but wrong column cannot pass overload binding', async () => {
  await assert.rejects(run(async (name, args) => args.operation ? { ...position, definitions: [{ path: 'Target.java', line: 2, column: 8 }] } : { candidates: [candidate] }), /definition does not bind/);
});

test('stale evidence and truncated previews cannot pass', async () => {
  for (const bad of [{ ...candidate, preview: '@Deprecated' }, { ...candidate, evidenceRange: { ...candidate.evidenceRange, contentHash: 'stale' } }]) {
    await assert.rejects(run(async () => ({ candidates: [bad] })), /evidence/);
  }
});

test('old locator transport error also fails the run', async () => {
  await assert.rejects(run(async (name, args) => !args.operation ? { candidates: [candidate] } : args.line === 1 ? { error: 'old transport failure' } : position), /old transport failure/);
});


test('rejected transport promise fails the probe', async () => {
  await assert.rejects(run(async () => { throw new Error('disconnected'); }), /disconnected/);
});

test('missing evidence fails rather than producing a successful summary', async () => {
  await assert.rejects(run(async () => ({ candidates: [{ ...candidate, evidenceRange: undefined }] })), /missing declaration evidence/);
});

for (const terminator of ['\n', '\r\n']) {
  test(`preserves ${terminator === '\n' ? 'LF' : 'CRLF'} terminators in exact preview evidence`, async () => {
    const terminatedSource = ['@Deprecated', 'class Target {}'].join(terminator) + terminator;
    const terminatedCandidate = { ...candidate, preview: terminatedSource,
      evidenceRange: { ...candidate.evidenceRange, contentHash: createHash('sha256').update(terminatedSource).digest('hex') } };
    const call = async (name, args) => args.operation ? position : { candidates: [terminatedCandidate] };
    const result = await runLocatorProbe({ repoRoot: '/fixture', queries: ['Target'], call,
      readSource: () => terminatedSource, sleep: async () => {} });
    assert.equal(result.summary.selectionResolvesDeclaration, 1);
    assert.equal(result.rows[0].oldLocatorText, '@Deprecated');
    for (const bad of [
      { ...terminatedCandidate, preview: terminatedSource.slice(0, -terminator.length) },
      { ...terminatedCandidate, evidenceRange: { ...terminatedCandidate.evidenceRange, endLine: 3 } }
    ]) {
      await assert.rejects(runLocatorProbe({ repoRoot: '/fixture', queries: ['Target'],
        call: async () => ({ candidates: [bad] }), readSource: () => terminatedSource,
        sleep: async () => {} }), /evidence/);
    }
  });
}
