import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { inspectFixtureSlots } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT } from "./ilv2-mac-contracts.mjs";

const executor = new URL("./ilv2-mac-fixture-exec.mjs", import.meta.url).href;
function start(file, args) {
  const source = `import {runFixtureProcess} from ${JSON.stringify(executor)}; try {process.exitCode=await runFixtureProcess(${JSON.stringify(file)},${JSON.stringify(args)});} catch(error){console.error(error.message);process.exitCode=1;}`;
  const wrapper = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio:["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  wrapper.stdout.on("data", bytes => { stdout += bytes; }); wrapper.stderr.on("data", bytes => { stderr += bytes; });
  const closed = new Promise((resolve,reject) => { wrapper.once("error",reject); wrapper.once("close",(code,signal)=>resolve({code,signal,stdout,stderr})); });
  return { wrapper, closed, output:()=>stdout };
}
async function poll(predicate, limit = 5000) {
  const deadline = Date.now()+limit;
  while (Date.now()<deadline) { const result=predicate(); if(result) return result; await delay(20); }
  throw new Error("fixture observation timed out");
}
function slots(pid) { return inspectFixtureSlots(MAC_WORK_ROOT).filter(row=>row.pid === pid); }

test("fixture executor admits before child runs, preserves natural status and releases quota", async () => {
  const run = start(process.execPath,["-e","console.log('child-ready');setTimeout(()=>process.exit(7),300)"]);
  await poll(()=>run.output().includes("child-ready"));
  const rows=slots(run.wrapper.pid);
  assert.equal(rows.length,1); assert.ok(rows[0].child_pid>0); assert.equal(rows[0].pgid,rows[0].child_pid);
  const result=await run.closed;
  assert.equal(result.code,7,result.stderr); assert.equal(result.signal,null); assert.equal(slots(run.wrapper.pid).length,0);
});

test("fixture executor forwards termination, kills only its stubborn group and releases quota", async () => {
  const run=start(process.execPath,["-e","process.on('SIGTERM',()=>console.log('term-forwarded'));console.log('child-ready');setInterval(()=>{},1000)"]);
  await poll(()=>run.output().includes("child-ready"));
  const [row]=slots(run.wrapper.pid); assert.ok(row.child_pid>0);
  const started=Date.now(); run.wrapper.kill("SIGTERM");
  const result=await run.closed;
  assert.equal(result.code,143,result.stderr); assert.match(result.stdout,/term-forwarded/);
  assert.ok(Date.now()-started<10000); assert.equal(slots(run.wrapper.pid).length,0);
  assert.throws(()=>process.kill(row.child_pid,0),{code:"ESRCH"});
  assert.throws(()=>process.kill(-row.pgid,0),{code:"ESRCH"});
});

test("fixture executor reports spawn failure and releases an unstarted reservation", async () => {
  const run=start("/nonexistent-ilv2-fixture-executable",[]);
  const result=await run.closed;
  assert.equal(result.code,1); assert.match(result.stderr,/ENOENT/); assert.equal(slots(run.wrapper.pid).length,0);
});
