// Diagnostic-only preload for one real seal. No SQL or worker result is replaced.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import path from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';

if (parentPort && workerData?.step) {
  const now = () => performance.timeOrigin + performance.now();
  const record = { step: workerData.step, threadId, startedAtMs: now(), tasks: [] };
  let profiler;
  if (workerData.step === 'verify-parts') {
    profiler = new Session(); profiler.connect();
    await profiler.post('Profiler.enable'); await profiler.post('Profiler.start');
  }
  let current;
  const finishTask = () => {
    if (current) { current.endedAtMs = now(); current.wallMs = current.endedAtMs - current.startedAtMs; }
  };
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (workerData.step === 'verify-parts') {
      const table = /^PRAGMA main\.integrity_check\('((?:[^']|'')*)'\)$/.exec(sql);
      const key = table ? `table:${table[1].replaceAll("''", "'")}`
        : sql === 'PRAGMA main.quick_check' ? 'global' : sql === 'PRAGMA main.foreign_key_check' ? 'common' : undefined;
      if (key) {
        finishTask();
        current = { key, startedAtMs: now(), synchronousAllGetMs: 0, allGetCalls: 0 };
        record.tasks.push(current);
      }
    }
    const statement = prepare.call(this, sql, ...args);
    for (const operation of ['all', 'get']) {
      const run = statement[operation];
      statement[operation] = function(...parameters) {
        const started = performance.now();
        try { return run.apply(this, parameters); }
        finally {
          if (current) { current.synchronousAllGetMs += performance.now() - started; current.allGetCalls++; }
        }
      };
    }
    return statement;
  };
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = function(reply, ...args) {
    finishTask(); record.repliedAtMs = now();
    record.replyKind = reply && 'error' in reply ? 'error' : 'value';
    if (workerData.step === 'verify-parts' && Array.isArray(reply?.value)) record.acknowledgements = reply.value;
    const send = (failure) => {
      if (failure) record.profileError = String(failure);
      try {
        writeFileSync(path.join(process.env.ILV2_EVIDENCE_ROOT, `seal-trace-thread-${threadId}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      } catch (error) { failure ??= error; console.error('seal trace evidence failed', error); }
      const outgoing = reply && 'error' in reply ? reply : failure ? { error: `seal CPU diagnostic failed: ${failure.message}` } : reply;
      try { return post(outgoing, ...args); }
      catch (error) { console.error('seal trace reply failed', error); process.exitCode = 1; }
    };
    if (!profiler) return send();
    void (async () => {
      let failure;
      try {
        const { profile } = await profiler.post('Profiler.stop');
        const file = `seal-trace-thread-${threadId}.cpuprofile`, json = JSON.stringify(profile);
        writeFileSync(path.join(process.env.ILV2_EVIDENCE_ROOT, file), json, { flag: 'wx' });
        record.cpuProfile = { file, sha256: createHash('sha256').update(json).digest('hex') };
      } catch (error) { failure = error; }
      finally {
        try { profiler.disconnect(); } catch (error) { failure ??= error; }
        send(failure);
      }
    })();
  };
}
