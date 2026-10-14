import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeMacNativeProcess } from "./native-exec.js";

test("native timeout and byte overflow kill and reap the actual child", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-executor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "fixture.c"), binary = path.join(root, "fixture"), pidFile = path.join(root, "pid.txt");
  await writeFile(source, `#include <stdio.h>\n#include <string.h>\n#include <signal.h>\n#include <unistd.h>\nint main(int argc,char**argv){if(argc>1&&strcmp(argv[1],"ready")==0){puts("READY");return 0;}signal(SIGTERM,SIG_IGN);FILE*f=fopen(${JSON.stringify(pidFile)},"w");if(!f)return 2;fprintf(f,"%d",getpid());fclose(f);if(strcmp(argv[1],"stdout")==0||strcmp(argv[1],"stderr")==0){FILE*out=strcmp(argv[1],"stderr")==0?stderr:stdout;for(int i=0;i<30000;i++)fputs("\\xe4\\xb8\\xad",out);fflush(out);}for(;;)pause();}\n`);
  await promisify(execFile)("/usr/bin/clang", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
  assert.equal((await executeMacNativeProcess(binary, ["ready"])).stdout.trim(), "READY");
  for (const mode of ["timeout", "stdout", "stderr"]) {
    const started = performance.now();
    await assert.rejects(executeMacNativeProcess(binary, [mode], { timeout: mode === "timeout" ? 300 : 5000 }),
      mode === "timeout" ? /deadline exceeded/ : new RegExp(`${mode} exceeds limit`));
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), error => (error as NodeJS.ErrnoException).code === "ESRCH");
    assert.ok(performance.now() - started < 1500);
  }
});
