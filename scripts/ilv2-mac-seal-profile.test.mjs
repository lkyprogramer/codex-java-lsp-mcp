import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';

test('MAC12 actual seal worker task timeline', {
  skip: process.env.ILV2_MAC12_SEAL_PROFILE !== 'worker-timeline' && 'MAC12 actual seal task trace not selected', timeout: 180000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baseline = JSON.parse(await readFile(path.join(root, 'baseline-db.json'))), file = await realpath(baseline.db);
  assert.ok(file.startsWith(root + '/tmp/'));
  const digest = async source => {
    const sha = createHash('sha256');
    for await (const chunk of createReadStream(source)) sha.update(chunk);
    return sha.digest('hex');
  };
  assert.equal(await digest(file), baseline.sha256);
  const preload = fileURLToPath(new URL('./ilv2-mac-seal-trace-preload.mjs', import.meta.url));
  const workers = [], OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(url, options) {
      const trace = { step: options.workerData.step, createdAtMs: performance.timeOrigin + performance.now() };
      super(url, { ...options, execArgv: [...(options.execArgv ?? []), '--import', pathToFileURL(preload).href] });
      trace.threadId = this.threadId; workers.push(trace);
      this.once('exit', code => { trace.exitCode = code; trace.exitedAtMs = performance.timeOrigin + performance.now(); });
    }
  };
  syncBuiltinESMExports();
  const work = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mac12-seal-timeline-'));
  let layout, primaryError;
  try {
    const api = await import(pathToFileURL(path.join(process.cwd(), 'dist/java-index/snapshot/seal.js')).href);
    const { cloneSealedDatabase } = await import(pathToFileURL(path.join(process.cwd(), 'dist/mac-platform/clonefile.js')).href);
    layout = api.mac1Layout(work);
    const job = path.join(layout.jobs, 'job-timeline');
    await mkdir(job, { recursive: true }); await mkdir(layout.snapshots, { recursive: true });
    const source = path.join(job, api.DB_FILE);
    await cloneSealedDatabase(file, source, root); await chmod(source, 0o644);
    assert.equal(await digest(source), baseline.sha256);
    const loadStart = os.loadavg()[0], startedAtMs = performance.timeOrigin + performance.now(), timings = {};
    const output = await api.sealJobDatabase(layout, job, { snapshotId: 'mac12-paired-publish', timings });
    const endedAtMs = performance.timeOrigin + performance.now(), loadEnd = os.loadavg()[0];
    const expected = JSON.parse(await readFile(path.join(root, 'raw/validation/seal-cap-compare/0.evidence/parallel-seal-comparison.json'))).expectedManifest;
    assert.deepEqual(output, expected);
    assert.deepEqual(await api.readSealedManifest(layout, output.snapshotId, { verifyFile: true }), expected);
    assert.equal(api.sealWorkerUsage().active, 0); assert.equal(api.sealWorkerUsage().queued, 0);
    assert.ok(workers.every(worker => worker.exitCode === 0));
    const traces = await Promise.all(workers.map(async worker => ({ ...worker,
      detail: JSON.parse(await readFile(path.join(process.env.ILV2_EVIDENCE_ROOT, `seal-trace-thread-${worker.threadId}.json`))) })));
    const cpuProfiles = [];
    for (const worker of traces.filter(worker => worker.step === 'verify-parts')) {
      const descriptor = worker.detail.cpuProfile;
      assert.ok(descriptor, 'each actual verifier supplies its own CPU profile');
      const profileFile = path.join(process.env.ILV2_EVIDENCE_ROOT, descriptor.file);
      assert.equal(await digest(profileFile), descriptor.sha256);
      const profile = JSON.parse(await readFile(profileFile));
      assert.ok(profile.nodes.length > 0 && profile.samples.length > 0 && profile.endTime > profile.startTime);
      cpuProfiles.push({ threadId: worker.threadId, ...descriptor, samples: profile.samples.length,
        sampledDurationUs: profile.endTime - profile.startTime });
    }
    const db = new DatabaseSync(file, { readOnly: true });
    let expectedTasks;
    try { expectedTasks = ['global', 'common', 'table:sqlite_schema', ...db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all().map(row => `table:${row.name}`)].sort(); }
    finally { db.close(); }
    const actualTasks = traces.flatMap(worker => worker.detail.tasks.map(task => task.key)).sort();
    assert.deepEqual(actualTasks, expectedTasks, 'every actual task has exactly one trace');
    const ackTasks = traces.flatMap(worker => (worker.detail.acknowledgements ?? []).map(task => task.kind === 'table' ? `table:${task.table}` : task.kind)).sort();
    assert.deepEqual(ackTasks, expectedTasks, 'trace boundaries agree with actual worker acknowledgements');
    assert.equal(await digest(file), baseline.sha256);
    await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'seal-worker-timeline.json'), JSON.stringify({
      status: 'DIAGNOSTIC_ONLY', gateStatus: 'NOT_GATED', costDecision: 'PROFILE_ONLY',
      attempts: [{ startedAtMs, endedAtMs, ms: endedAtMs - startedAtMs, loadStart, loadEnd,
        category: [loadStart, loadEnd].every(load => load >= 0 && load < 20) ? 'VALID' : 'INVALID_EXPERIMENT' }],
      timings, workers: traces, cpuProfiles, dbSha256: baseline.sha256, manifestEquivalent: true, databaseBytesUnchanged: true,
      preloadSha256: await digest(preload), probeSha256: await digest(fileURLToPath(import.meta.url)),
      claim: 'Instrumented real seal task timeline and per-verifier CPU profiles; all/get durations exclude preparation/iteration. Remaining task wall includes iteration, decode, scheduling and profiler overhead. Worker lifetime also includes profile finalization. Not an uninstrumented performance gate.'
    }, null, 2) + '\n');
  } catch (error) {
    primaryError = error; throw error;
  } finally {
    workerThreads.Worker = OriginalWorker; syncBuiltinESMExports();
    try {
      if (layout) {
        const target = path.join(layout.snapshots, 'mac12-paired-publish');
        if (existsSync(target)) await chmod(target, 0o755);
      }
      await rm(work, { recursive: true, force: true });
    } catch (error) {
      await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'seal-timeline-cleanup-error.json'), JSON.stringify({
        primaryError: primaryError?.stack ?? null, cleanupError: error.stack ?? String(error)
      }, null, 2) + '\n').catch(logError => { console.error('seal trace cleanup evidence failed', logError); });
      if (!primaryError) throw error;
    }
  }
});

test('MAC12 facts decoder allocation costs on a registered database', {
  skip: process.env.ILV2_MAC12_SEAL_PROFILE !== 'facts-buffer-costs' && 'MAC12 decoder allocation profile not selected', timeout: 180000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baselineRecord = await readFile(path.join(root, 'baseline-db.json'));
  const baseline = JSON.parse(baselineRecord), file = await realpath(baseline.db);
  assert.ok(file.startsWith(root + '/tmp/'));
  const digest = async () => {
    const sha = createHash('sha256');
    for await (const chunk of createReadStream(file)) sha.update(chunk);
    return sha.digest('hex');
  };
  assert.equal(await digest(), baseline.sha256);
  const { logicalTableNames } = await import(pathToFileURL(path.join(process.cwd(), 'dist/java-index/sql/logical-export.js')).href);
  const db = new DatabaseSync(file, { readOnly: true });
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  const result = { status: 'RUNNING', gateStatus: 'NOT_GATED', costDecision: 'PROFILE_ONLY', attempts: [],
    dbSha256: baseline.sha256, candidateChunkBytes: 1024,
    probeSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    claim: 'Serial SQL iteration plus inflate/UTF8/JSON parse only; product decoder unchanged. No parallel seal, allocation-count, owner or G12 performance claim.' };
  const save = () => writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'facts-buffer-costs.json'), JSON.stringify(result, null, 2) + '\n');
  await save();
  try {
    const statements = logicalTableNames(db).filter(table => db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().some(column => column.name === 'facts'))
      .map(table => ({ table, statement: db.prepare(`SELECT facts FROM main.${quote(table)}`) }));
    const lengths = [], tables = [];
    for (const { table, statement } of statements) {
      let rows = 0;
      for (const { facts } of statement.iterate()) {
        assert.ok(facts instanceof Uint8Array);
        const original = inflateRawSync(facts), small = inflateRawSync(facts, { chunkSize: 1024 });
        assert.ok(original.equals(small), 'decoded bytes are identical before timing');
        JSON.parse(original.toString('utf8'));
        lengths.push(original.length); rows++;
      }
      tables.push({ table, rows });
    }
    lengths.sort((a, b) => a - b);
    result.payloads = { rows: lengths.length, tables, maxBytes: lengths.at(-1) ?? 0,
      p50Bytes: lengths[Math.floor(lengths.length * .5)] ?? 0, p95Bytes: lengths[Math.floor(lengths.length * .95)] ?? 0,
      fits1024: lengths.filter(length => length <= 1024).length };
    for (let round = 0; round < 3; round++) {
      for (const implementation of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const sample = { round, implementation, loadStart: os.loadavg()[0] };
        const options = implementation === 'candidate' ? { chunkSize: 1024 } : undefined;
        const start = performance.now(), cpu = process.cpuUsage();
        let rows = 0;
        for (const { statement } of statements) for (const { facts } of statement.iterate()) {
          JSON.parse(inflateRawSync(facts, options).toString('utf8')); rows++;
        }
        sample.ms = performance.now() - start; sample.loadEnd = os.loadavg()[0];
        const used = process.cpuUsage(cpu); sample.cpuMs = (used.user + used.system) / 1000;
        sample.rows = rows;
        assert.equal(rows, lengths.length);
        sample.category = [sample.loadStart, sample.loadEnd].every(load => load >= 0 && load < 20) ? 'VALID' : 'INVALID_EXPERIMENT';
        result.attempts.push(sample); await save();
      }
    }
    result.pairs = Array.from({ length: 3 }, (_, round) => {
      const rows = result.attempts.filter(sample => sample.round === round);
      const valid = rows.every(sample => sample.category === 'VALID');
      const baselineMs = rows.find(sample => sample.implementation === 'baseline').ms;
      const candidateMs = rows.find(sample => sample.implementation === 'candidate').ms;
      return { round, category: valid ? 'VALID' : 'INVALID_EXPERIMENT', baselineMs, candidateMs,
        improvement: valid ? 1 - candidateMs / baselineMs : null };
    });
    result.measurementComplete = result.pairs.every(pair => pair.category === 'VALID');
    result.costDecision = !result.measurementComplete ? 'INCOMPLETE' : result.pairs.every(pair => pair.improvement >= .2) ? 'SUPPORTS_DECODER_TRIAL' : 'INSUFFICIENT_GAIN';
    result.decodedBytesEquivalent = true;
  } finally { db.close(); }
  assert.equal(await digest(), baseline.sha256);
  result.databaseBytesUnchanged = true; result.status = 'DIAGNOSTIC_ONLY'; await save();
});

test('MAC12 bounded verification compares actual complete seal publication', {
  skip: !['parallel-compare', 'seal-cap-compare', 'method-cap-compare', 'json-syntax-compare'].includes(process.env.ILV2_MAC12_SEAL_PROFILE) && 'MAC12 complete seal comparison not selected', timeout: 900000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baselineRecord = await readFile(path.join(root, 'baseline-db.json'));
  const baseline = JSON.parse(baselineRecord);
  const capMode = process.env.ILV2_MAC12_SEAL_PROFILE === 'seal-cap-compare';
  const methodCapMode = process.env.ILV2_MAC12_SEAL_PROFILE === 'method-cap-compare';
  const jsonSyntaxMode = process.env.ILV2_MAC12_SEAL_PROFILE === 'json-syntax-compare';
  const oldRecord = await readFile(path.join(root, jsonSyntaxMode ? 'json-syntax-baseline.json' : methodCapMode ? 'method-cap-baseline.json' : capMode ? 'seal-cap-baseline.json' : 'parallel-baseline.json'));
  const old = JSON.parse(oldRecord), file = await realpath(baseline.db), previous = await realpath(old.candidateRoot);
  assert.ok([file, previous].every(value => value.startsWith(root + '/tmp/')));
  assert.equal(process.versions.sqlite, '3.49.1');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const digest = async source => {
    const sha = createHash('sha256');
    for await (const chunk of createReadStream(source)) sha.update(chunk);
    return sha.digest('hex');
  };
  assert.equal(await digest(file), baseline.sha256);
  const inventory = async directory => {
    const rows = [];
    async function visit(dir) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) await visit(full);
        else if (item.isFile() && item.name.endsWith('.js')) rows.push([path.relative(directory, full), hash(await readFile(full))]);
      }
    }
    await visit(path.join(directory, 'dist'));
    return rows.sort(([a], [b]) => a.localeCompare(b));
  };
  const oldFiles = await inventory(previous), newFiles = await inventory(process.cwd()), oldMap = new Map(oldFiles);
  assert.ok(oldFiles.every(([name]) => newFiles.some(([current]) => current === name)), 'no compiled file disappears');
  const changed = newFiles.filter(([name, sha]) => oldMap.get(name) !== sha).map(([name]) => name);
  assert.deepEqual(changed, (jsonSyntaxMode ? ['dist/java-index/snapshot/snapshot-store.test.js', 'dist/java-index/sql/logical-export.js',
    'dist/java-index/sql/logical-export.test.js', 'dist/java-index/sql/rows.js']
    : methodCapMode ? ['dist/java-index/snapshot/seal-integrity.test.js', 'dist/java-index/snapshot/seal-worker.js',
    'dist/java-index/snapshot/seal.js', 'dist/java-index/snapshot/snapshot-store.test.js', 'dist/java-index/sql/logical-export.js', 'dist/java-index/sql/logical-export.test.js']
    : capMode ? ['dist/java-index/snapshot/seal-integrity.test.js', 'dist/java-index/snapshot/seal-worker.js', 'dist/java-index/snapshot/seal.js']
    : ['dist/java-index/snapshot/seal-integrity.test.js', 'dist/java-index/snapshot/seal-worker.js',
    'dist/java-index/snapshot/seal.js', 'dist/java-index/snapshot/snapshot-store.test.js',
    'dist/java-index/sql/logical-export.js']).sort((a, b) => a.localeCompare(b)));
  assert.equal(hash(JSON.stringify(oldFiles)), old.compiledDigest, 'registered baseline compiled identity');
  const load = directory => import(pathToFileURL(path.join(directory, 'dist/java-index/snapshot/seal.js')).href);
  const implementations = { baseline: await load(previous), candidate: await load(process.cwd()) };
  const { cloneSealedDatabase } = await import(pathToFileURL(path.join(process.cwd(), 'dist/mac-platform/clonefile.js')).href);
  const result = { status: 'RUNNING', gateStatus: 'NOT_GATED', attempts: [],
    dbSha256: baseline.sha256, baselineSource: old.sourceDigest, baselineRecordSha256: hash(baselineRecord),
    baselineCandidateRecordSha256: hash(oldRecord), baselineCompiledDigest: hash(JSON.stringify(oldFiles)),
    candidateCompiledDigest: hash(JSON.stringify(newFiles)), changedCompiledFiles: changed,
    probeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    claim: 'Actual sealJobDatabase wall time, including checkpoint, plan scans, worker wait, all checks, hash, manifest, fsync and rename. Clone setup is outside this target cost and recorded separately. No owner, absolute G12 or query claim.' };
  const save = () => writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'parallel-seal-comparison.json'), JSON.stringify(result, null, 2) + '\n');
  await save();
  let expected;
  for (let round = 0; round < 3; round++) {
    for (const implementation of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const api = implementations[implementation];
      const work = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mac12-seal-pair-'));
      const layout = api.mac1Layout(work), job = path.join(layout.jobs, 'job-paired');
      const sample = { round, implementation, inputSha256: baseline.sha256 }, timings = {};
      let output, primaryError;
      try {
        await mkdir(job, { recursive: true }); await mkdir(layout.snapshots, { recursive: true });
        const source = path.join(job, api.DB_FILE), cloneStart = performance.now();
        // Use the same native clonefile path as the product; libuv's forced
        // FICLONE copy reports ENOSYS on this pinned macOS Node runtime.
        await cloneSealedDatabase(file, source, root); await chmod(source, 0o644);
        sample.cloneMechanism = 'existing-native-clonefile';
        sample.cloneSetupMs = performance.now() - cloneStart;
        assert.equal(await digest(source), baseline.sha256);
        sample.loadStart = os.loadavg()[0];
        const started = performance.now(), cpu = process.cpuUsage();
        try {
          output = await api.sealJobDatabase(layout, job, { snapshotId: 'mac12-paired-publish', timings });
        } finally {
          sample.ms = performance.now() - started; sample.loadEnd = os.loadavg()[0];
          const used = process.cpuUsage(cpu); sample.cpuMs = (used.user + used.system) / 1000;
          sample.timings = timings;
        }
        expected ??= output;
        assert.deepEqual(output, expected, 'every manifest field and sealed database identity are exactly equivalent');
        assert.deepEqual(await api.readSealedManifest(layout, output.snapshotId, { verifyFile: true }), expected);
        assert.deepEqual((await readdir(path.join(layout.snapshots, output.snapshotId))).sort(), [api.DB_FILE, api.MANIFEST_FILE].sort());
        assert.equal((await stat(path.join(layout.snapshots, output.snapshotId, api.DB_FILE))).mode & 0o222, 0);
        assert.deepEqual(await readdir(job), [], 'no source or sidecars left after the actual rename');
        if (api.sealWorkerUsage) {
          sample.workerUsageAfterSeal = api.sealWorkerUsage();
          assert.equal(sample.workerUsageAfterSeal.active, 0); assert.equal(sample.workerUsageAfterSeal.queued, 0);
          assert.equal(sample.workerUsageAfterSeal.peak, api.SEAL_WORKER_LIMIT);
        }
        sample.category = [sample.loadStart, sample.loadEnd].every(value => value >= 0 && value < 20) ? 'VALID' : 'INVALID_EXPERIMENT';
        sample.manifestAndBytesEquivalent = true;
      } catch (error) {
        primaryError = error; sample.error = error.stack ?? String(error);
        sample.category = sample.ms === undefined ? 'NOT_MEASURED' : 'FAILED_VALIDATION';
        result.status = 'FAILED'; throw error;
      } finally {
        let cleanupError;
        try {
          const target = path.join(layout.snapshots, 'mac12-paired-publish');
          if (existsSync(target)) await chmod(target, 0o755);
          await rm(work, { recursive: true, force: true });
          sample.privateFixtureRemoved = true;
        } catch (error) { cleanupError = error; sample.cleanupError = error.stack ?? String(error); }
        result.attempts.push(sample); await save();
        if (cleanupError && !primaryError) throw cleanupError;
      }
    }
  }
  // The unchanged full logical export remains an independent oracle outside timing.
  const { logicalDigest } = await import(pathToFileURL(path.join(process.cwd(), 'dist/java-index/sql/logical-export.js')).href);
  const oracle = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(logicalDigest(oracle).digest, baseline.expectedLogicalDigest); }
  finally { oracle.close(); }
  assert.equal(await digest(file), baseline.sha256);
  result.pairs = Array.from({ length: 3 }, (_value, round) => {
    const rows = result.attempts.filter(sample => sample.round === round);
    const valid = rows.length === 2 && rows.every(sample => sample.category === 'VALID');
    const baselineMs = rows.find(sample => sample.implementation === 'baseline').ms;
    const candidateMs = rows.find(sample => sample.implementation === 'candidate').ms;
    return { round, category: valid ? 'VALID' : 'INVALID_EXPERIMENT', baselineMs, candidateMs,
      improvement: valid ? 1 - candidateMs / baselineMs : null };
  });
  result.measurementComplete = result.pairs.every(pair => pair.category === 'VALID');
  result.costDecision = !result.measurementComplete ? 'INCOMPLETE' : result.pairs.every(pair => pair.improvement >= .2) ? 'SUPPORTS_CANDIDATE' : 'INSUFFICIENT_GAIN';
  result.status = 'DIAGNOSTIC_ONLY'; result.databaseBytesUnchanged = true; result.offlineLogicalDigestEquivalent = true;
  result.manifestEquivalence = 'EXACT'; result.expectedManifest = expected;
  await save();
});

test('MAC12 complete integrity partition costs on a registered database', {
  skip: process.env.ILV2_MAC12_SEAL_PROFILE !== 'integrity-costs' && 'MAC12 integrity cost profile not selected', timeout: 180000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baseline = JSON.parse(await readFile(path.join(root, 'baseline-db.json')));
  const file = await realpath(baseline.db);
  assert.ok(file.startsWith(root + '/tmp/'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(file)), baseline.sha256);
  const prior = await readFile(path.join(root, 'raw/validation/seal-check-profile/3.evidence/check-profile.json'));
  const profile = JSON.parse(prior);
  assert.equal(profile.dbSha256, baseline.sha256);
  const reader = new DatabaseSync(file, { readOnly: true }), operations = [];
  const sample = { loadStart: os.loadavg()[0] }, started = performance.now();
  try {
    // No logical-export filtering: include sym, meta, internal tables and the schema.
    const tables = ['sqlite_schema', ...reader.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name)];
    assert.equal(new Set(tables).size, tables.length);
    for (const table of [null, ...tables]) {
      const sql = table === null ? 'PRAGMA main.quick_check' : `PRAGMA main.integrity_check('${table.replaceAll("'", "''")}')`;
      const now = performance.now(), rows = reader.prepare(sql).all();
      const ms = performance.now() - now;
      assert.deepEqual(rows.map(row => Object.values(row)[0]), ['ok']);
      operations.push({ table, kind: table === null ? 'global-quick' : 'full-table', ms });
    }
    assert.equal(operations.length, tables.length + 1);
    sample.ms = performance.now() - started; sample.loadEnd = os.loadavg()[0];
    sample.category = [sample.loadStart, sample.loadEnd].every(value => value >= 0 && value < 20) ? 'VALID' : 'INVALID_EXPERIMENT';
  } finally { reader.close(); }
  assert.equal(hash(await readFile(file)), baseline.sha256);
  await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'integrity-partition-costs.json'), JSON.stringify({
    status: 'DIAGNOSTIC_ONLY', gateStatus: 'NOT_GATED', costDecision: 'PROFILE_ONLY', attempts: [sample], operations,
    priorFullIntegrityMs: profile.attempts[0].integrityMs, priorProfileSha256: hash(prior),
    probeSha256: hash(await readFile(fileURLToPath(import.meta.url))), dbSha256: baseline.sha256, databaseBytesUnchanged: true,
    claim: 'Healthy-file serial cost profile only. No corruption equivalence, parallel gain, bounded-worker proof or product-check replacement is claimed.'
  }, null, 2) + '\n');
});

test('MAC12 posting reference validation alternatives', {
  skip: process.env.ILV2_MAC12_SEAL_PROFILE !== 'references' && 'MAC12 reference alternatives not selected', timeout: 180000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baseline = JSON.parse(await readFile(path.join(root, 'baseline-db.json')));
  const file = await realpath(baseline.db);
  assert.ok(file.startsWith(root + '/tmp/'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(file)), baseline.sha256);
  const input = await readFile(path.join(root, 'raw/validation/seal-check-profile/3.evidence/check-profile.json'));
  const profile = JSON.parse(input);
  assert.equal(profile.dbSha256, baseline.sha256);
  const targets = { entity_token: [['entity_sym', 'sym'], ['token_sym', 'sym']],
    search_doc_token: [['doc_id', 'search_doc'], ['token_sym', 'sym']] };
  const reader = new DatabaseSync(file, { readOnly: true });
  const attempts = [];
  try {
    for (const [table, refs] of Object.entries(targets)) {
      const original = profile.queries.filter(row => row.table === table && row.kind === 'orphan');
      assert.equal(original.length, 1);
      const sql = original[0].sql;
      assert.ok(sql.includes(`FROM main."${table}" t `));
      const variants = {
        natural: [sql.replace(`FROM main."${table}" t `, `FROM main."${table}" t NOT INDEXED `)],
        distinct: refs.map(([column, target]) => `SELECT 1 FROM (SELECT DISTINCT "${column}" AS refId FROM main."${table}"
          WHERE "${column}" IS NOT NULL) refs WHERE NOT EXISTS (SELECT 1 FROM main."${target}" r WHERE r.id=refs.refId) LIMIT 1`)
      };
      for (const [strategy, queries] of Object.entries(variants)) {
        const sample = { table, strategy, loadStart: os.loadavg()[0], queries: [] }, started = performance.now();
        for (const statement of queries) assert.equal(reader.prepare(statement).get(), undefined);
        sample.ms = performance.now() - started;
        sample.loadEnd = os.loadavg()[0];
        sample.category = [sample.loadStart, sample.loadEnd].every(value => value >= 0 && value < 20) ? 'VALID' : 'INVALID_EXPERIMENT';
        // Plans are outside measured query execution.
        sample.queries = queries.map(statement => ({ sql: statement, plan: reader.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() }));
        attempts.push(sample);
      }
    }
  } finally { reader.close(); }
  assert.equal(hash(await readFile(file)), baseline.sha256);
  await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'posting-reference-alternatives.json'), JSON.stringify({
    status: 'DIAGNOSTIC_ONLY', gateStatus: 'NOT_GATED', costDecision: 'PROFILE_ONLY', attempts,
    baselineOrphanQueries: profile.queries.filter(row => row.kind === 'orphan' && row.table in targets),
    inputProfileSha256: hash(input), probeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    dbSha256: baseline.sha256, databaseBytesUnchanged: true,
    claim: 'One diagnostic per alternative, not repeated improvement evidence. Original query costs are reused from the prior valid profile. No product change or G12 claim.'
  }, null, 2) + '\n');
});

test('MAC12 remaining seal validation check costs', {
  skip: process.env.ILV2_MAC12_SEAL_PROFILE !== 'checks' && 'MAC12 check profile not selected', timeout: 180000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baselineFile = path.join(root, 'baseline-db.json');
  const baseline = JSON.parse(await readFile(baselineFile));
  const candidate = JSON.parse(await readFile(path.join(root, 'candidate.json')));
  const frozen = await realpath(path.join(candidate.validationRoot, 'candidate'));
  const file = await realpath(baseline.db);
  assert.ok([file, frozen].every(value => value.startsWith(root + '/tmp/')));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(file)), baseline.sha256);
  // This helper changed; the measured product must remain the reviewed one.
  const inventory = async directory => {
    const rows = [];
    async function visit(dir) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) await visit(full);
        else if (item.isFile() && item.name.endsWith('.js')) rows.push([path.relative(directory, full), hash(await readFile(full))]);
      }
    }
    await visit(path.join(directory, 'dist'));
    return rows.sort(([a], [b]) => a.localeCompare(b));
  };
  const compiled = await inventory(frozen);
  assert.deepEqual(await inventory(process.cwd()), compiled);
  const at = name => import(pathToFileURL(path.join(frozen, 'dist', name)).href);
  const { validateLogicalData } = await at('java-index/sql/logical-export.js');
  const { compatibleDeltaBase } = await at('index-builder/execution-plan.js');
  const queries = [], tableCosts = [];
  let currentTable;
  const finishTable = () => {
    if (!currentTable) return;
    const used = process.cpuUsage(currentTable.cpu);
    tableCosts.push({ table: currentTable.table, ms: performance.now() - currentTable.started,
      cpuMs: (used.user + used.system) / 1000 });
    currentTable = undefined;
  };
  const reader = new DatabaseSync(file, { readOnly: true });
  const db = new Proxy(reader, { get(target, key) {
    if (key !== 'prepare') {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return sql => {
      // validateLogicalTable starts with this metadata read. Wall time until
      // the next table includes its reference/scalar SQL AND caller facts decode.
      const tableInfo = /^PRAGMA main\.table_info\("([^"]+)"\)$/.exec(sql);
      if (tableInfo) {
        finishTable();
        currentTable = { table: tableInfo[1], started: performance.now(), cpu: process.cpuUsage() };
      }
      const metric = { sql, table: /FROM main\."([^"]+)"/.exec(sql)?.[1] ?? null,
        kind: /integrity_check/.test(sql) ? 'integrity' : /foreign_key_check/.test(sql) ? 'foreign-key' :
          /9007199254740991/.test(sql) ? 'scalar-integer' : /AS orphan|NOT EXISTS/.test(sql) ? 'orphan' :
            /^SELECT "facts" FROM/.test(sql) ? 'facts' : 'metadata', prepareMs: 0, executeMs: 0, rows: 0 };
      const start = performance.now();
      const statement = target.prepare(sql);
      metric.prepareMs = performance.now() - start;
      queries.push(metric);
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'get' || method === 'all') return (...args) => {
          const now = performance.now();
          try { return stmt[method](...args); } finally { metric.executeMs += performance.now() - now; }
        };
        if (method === 'iterate') return function* (...args) {
          const iterator = stmt.iterate(...args);
          try {
            while (true) {
              const now = performance.now();
              let row;
              try { row = iterator.next(); } finally { metric.executeMs += performance.now() - now; }
              if (row.done) break;
              metric.rows++;
              yield row.value;
            }
          } finally { iterator.return?.(); }
        };
        const value = Reflect.get(stmt, method, stmt);
        return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
  } });
  const sample = { loadStart: os.loadavg()[0] }, started = performance.now(), cpu = process.cpuUsage();
  const phase = (name, fn) => { const now = performance.now(); try { return fn(); } finally { sample[name] = performance.now() - now; } };
  try {
    phase('integrityMs', () => assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']));
    phase('foreignKeyMs', () => assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []));
    phase('censusMs', () => assert.equal(compatibleDeltaBase(db), true));
    phase('logicalDataMs', () => { try { validateLogicalData(db); } finally { finishTable(); } });
    sample.ms = performance.now() - started;
    const used = process.cpuUsage(cpu); sample.cpuMs = (used.user + used.system) / 1000;
    sample.loadEnd = os.loadavg()[0];
    sample.category = [sample.loadStart, sample.loadEnd].every(value => value >= 0 && value < 20) ? 'VALID' : 'INVALID_EXPERIMENT';
    // EXPLAIN is outside measured phases, only for the actual hot validation SQL.
    for (const metric of queries.filter(row => ['scalar-integer', 'orphan', 'facts'].includes(row.kind))) {
      metric.plan = reader.prepare(`EXPLAIN QUERY PLAN ${metric.sql}`).all();
    }
  } finally { reader.close(); }
  assert.equal(hash(await readFile(file)), baseline.sha256);
  const result = { status: 'DIAGNOSTIC_ONLY', gateStatus: 'NOT_GATED', costDecision: 'PROFILE_ONLY',
    measurementComplete: true, attempts: [sample], queries, tableCosts,
    measuredProductSource: candidate.sourceDigest, compiledDigest: hash(JSON.stringify(compiled)),
    probeSha256: hash(await readFile(fileURLToPath(import.meta.url))), baselineRecordSha256: hash(await readFile(baselineFile)),
    dbSha256: baseline.sha256, databaseBytesUnchanged: true,
    claim: 'One instrumented serial verification diagnostic. Per-table wall time includes metadata, reference/scalar SQL and caller facts decode; lazy iterator next() separately excludes caller decode. No parallel timeline, speedup or G12 claim.' };
  await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, 'check-profile.json'), JSON.stringify(result, null, 2) + '\n');
});

// Opt-in same-input diagnostic; actual owner publication and G12 gates remain separate.
test('MAC12 seal validation preserves data checks without an unused logical manifest', {
  skip: !['compare', 'reference-compare'].includes(process.env.ILV2_MAC12_SEAL_PROFILE) && 'MAC12 paired comparison not selected', timeout: 900000
}, async () => {
  const root = await realpath(process.env.ILV2_RUN_ROOT);
  const baselineFile = path.join(root, 'baseline-db.json');
  const baseline = JSON.parse(await readFile(baselineFile));
  const referenceMode = process.env.ILV2_MAC12_SEAL_PROFILE === 'reference-compare';
  const referenceBaseline = referenceMode ? JSON.parse(await readFile(path.join(root, 'reference-baseline.json'))) : null;
  const file = await realpath(baseline.db), previous = await realpath(referenceBaseline?.candidateRoot ?? baseline.baselineCandidateRoot);
  assert.equal(file, baseline.db);
  assert.ok([file, previous].every(value => value.startsWith(root + '/tmp/')), 'only registered run state is used');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(file)), baseline.sha256);
  const inventory = async directory => {
    const out = [];
    async function visit(dir) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) await visit(full);
        else if (item.isFile() && item.name.endsWith('.js')) out.push([path.relative(directory, full), hash(await readFile(full))]);
      }
    }
    await visit(path.join(directory, 'dist'));
    return out.sort(([a],[b]) => a.localeCompare(b));
  };
  const oldFiles = await inventory(previous), newFiles = await inventory(process.cwd());
  assert.deepEqual(newFiles.map(([name]) => name), oldFiles.map(([name]) => name));
  const changed = newFiles.filter((row,index) => row[1] !== oldFiles[index][1]).map(([name]) => name);
  assert.deepEqual(changed, (referenceMode
    ? ['dist/java-index/snapshot/snapshot-store.test.js', 'dist/java-index/sql/logical-export.js', 'dist/java-index/sql/logical-export.test.js']
    : ['dist/java-index/snapshot/seal-worker.js', 'dist/java-index/snapshot/snapshot-store.test.js',
      'dist/java-index/sql/logical-export.js', 'dist/java-index/sql/logical-export.test.js',
      'dist/java-index/sql/snapshot-manifest.js']).sort((a,b) => a.localeCompare(b)));
  const load = async directory => {
    const at = name => import(pathToFileURL(path.join(directory, 'dist', name)).href);
    return { ...(await at('java-index/sql/snapshot-manifest.js')), ...(await at('java-index/sql/logical-export.js')),
      ...(await at('index-builder/execution-plan.js')) };
  };
  const implementations = { baseline: await load(previous), candidate: await load(process.cwd()) };
  const evidence = process.env.ILV2_EVIDENCE_ROOT;
  const result = { status: 'RUNNING', gateStatus: 'NOT_GATED', probeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    baselineRecordSha256: hash(await readFile(baselineFile)), dbSha256: baseline.sha256, changedCompiledFiles: changed, baselineCompiledDigest: hash(JSON.stringify(oldFiles)),
    candidateCompiledDigest: hash(JSON.stringify(newFiles)), attempts: [],
    claim: 'Combined verification+manifest cost only, including explicit data validation. No owner, absolute G12 or query claim.' };
  const save = () => writeFile(path.join(evidence, 'seal-comparison.json'), JSON.stringify(result, null, 2) + '\n');
  await save();
  let expected;
  const bytes = (await stat(file)).size;
  for (let round = 0; round < 3; round++) {
    for (const implementation of round % 2 ? ['candidate','baseline'] : ['baseline','candidate']) {
      const api = implementations[implementation];
      const reader = new DatabaseSync(file, { readOnly: true });
      const sample = { round, implementation, loadStart: os.loadavg()[0] };
      let manifest;
      const cpu = process.cpuUsage(), started = performance.now();
      try {
        const verifyStart = performance.now();
        assert.deepEqual(reader.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
        assert.deepEqual(reader.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(api.compatibleDeltaBase(reader), true);
        if (implementation === 'candidate' || referenceMode) api.validateLogicalData(reader);
        const pageSize = reader.prepare('PRAGMA page_size').get().page_size;
        sample.verifyMs = performance.now() - verifyStart;
        const manifestStart = performance.now();
        manifest = api.buildSnapshotManifest(reader, { snapshotId: 'mac12-paired-probe', bytes, pageSize, sha256: baseline.sha256 });
        sample.manifestMs = performance.now() - manifestStart;
      }
      finally {
        reader.close(); sample.ms = performance.now() - started; sample.loadEnd = os.loadavg()[0];
        const used = process.cpuUsage(cpu); sample.cpuMs = (used.user + used.system) / 1000;
      }
      if (referenceMode) {
        expected ??= manifest;
        assert.deepEqual(manifest, expected, 'every complete manifest field must remain identical');
      } else if (implementation === 'baseline') {
        assert.equal(manifest.logical.digest, baseline.expectedLogicalDigest);
        const { logical, ...rest } = manifest;
        expected ??= { ...rest, formatVersion: implementations.candidate.SNAPSHOT_MANIFEST_FORMAT };
        assert.deepEqual({ ...rest, formatVersion: expected.formatVersion }, expected);
      } else {
        assert.ok(expected, 'baseline is measured first');
        assert.deepEqual(manifest, expected, 'only formatVersion and the unused logical field may change');
      }
      sample.category = [sample.loadStart,sample.loadEnd].every(value => value >= 0 && value < 20) ? 'VALID' : 'INVALID_EXPERIMENT';
      result.attempts.push(sample); await save();
    }
  }
  // Independent semantic truth stays outside the timing comparison.
  const oracle = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(implementations.candidate.logicalDigest(oracle).digest, baseline.expectedLogicalDigest); }
  finally { oracle.close(); }
  assert.equal(hash(await readFile(file)), baseline.sha256, 'database bytes unchanged after all comparisons');
  const median = rows => rows.map(row => row.ms).toSorted((a,b) => a-b)[Math.floor(rows.length/2)];
  result.summary = Object.fromEntries(['baseline','candidate'].map(name => {
    const valid = result.attempts.filter(row => row.implementation === name && row.category === 'VALID');
    return [name, { validN: valid.length, medianMs: median(valid) }];
  }));
  result.measurementComplete = Object.values(result.summary).every(value => value.validN === 3);
  result.improvement = result.measurementComplete ? 1 - result.summary.candidate.medianMs / result.summary.baseline.medianMs : null;
  result.costDecision = !result.measurementComplete ? 'INCOMPLETE' : result.improvement >= .2 ? 'SUPPORTS_CANDIDATE' : 'INSUFFICIENT_GAIN';
  result.status = 'DIAGNOSTIC_ONLY'; result.databaseBytesUnchanged = true; result.offlineLogicalDigestEquivalent = true;
  result.manifestEquivalence = referenceMode ? 'EXACT' : 'EXCEPT_EXPLICIT_FORMAT_AND_LOGICAL_REMOVAL';
  result.referenceBaselineSource = referenceBaseline?.sourceDigest ?? null;
  await save();
});
