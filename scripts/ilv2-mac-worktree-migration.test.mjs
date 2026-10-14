import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./ilv2-mac-contracts.mjs";
import { parseWorktrees, planMigration } from "./ilv2-mac-worktree-migration.mjs";

const git = (...args) => execute("git", args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
const toplevel = async dir => (await git("-C", dir, "rev-parse", "--show-toplevel")).stdout.trim();

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "worktree-migration-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = path.join(root, "from"), to = path.join(root, "to"), elsewhere = path.join(root, "elsewhere");
  const main = path.join(from, "group/repo");
  await mkdir(main, { recursive: true }); await mkdir(elsewhere);
  await git("-C", main, "init", "-q", "-b", "main");
  await writeFile(path.join(main, "a.txt"), "a\n");
  await git("-C", main, "add", "a.txt"); await git("-C", main, "commit", "-q", "-m", "init");
  const sibling = path.join(from, "group/repo-feature"), locked = path.join(from, "other/repo-locked");
  const external = path.join(elsewhere, "repo-tmp"), gone = path.join(from, "repo-gone");
  await git("-C", main, "worktree", "add", "-q", "-b", "feature", sibling);
  await git("-C", main, "worktree", "add", "-q", "--lock", "-b", "locked", locked);
  await git("-C", main, "worktree", "add", "-q", "-b", "external", external);
  await git("-C", main, "worktree", "add", "-q", "-b", "gone", gone);
  await rm(gone, { recursive: true });
  return { root, from, to, main, sibling, locked, external };
}

test("porcelain parsing keeps locked, prunable and detached flags", () => {
  const rows = parseWorktrees("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b c\nHEAD 2\ndetached\nlocked\n\nworktree /d\nHEAD 3\nprunable gitdir file points to non-existent location\n\n");
  assert.deepEqual(rows.map(row => [row.path, row.locked, row.prunable, row.detached]), [["/a", false, false, false], ["/b c", true, false, true], ["/d", false, true, false]]);
});

test("generated scripts move main and linked worktrees, keep external ones linked, and roll back", async t => {
  const f = await fixture(t);
  const out = path.join(f.root, "plan");
  const plan = await planMigration({ roots: [f.main], fromRoot: f.from, toRoot: f.to, out });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.totals, { mains: 1, linkedMoves: 2, externalRepairs: 1, prunableUntouched: 1 });
  await assert.rejects(planMigration({ roots: [f.main], fromRoot: f.from, toRoot: f.to, out }), /already exists/);
  // Nothing moved during planning.
  assert.equal(await toplevel(f.main), f.main);

  const run = name => execute("/bin/sh", [path.join(out, `${name}.sh`)]);
  await run("migrate");
  await run("verify");
  const moved = { main: path.join(f.to, "group/repo"), sibling: path.join(f.to, "group/repo-feature"), locked: path.join(f.to, "other/repo-locked") };
  for (const dir of Object.values(moved)) assert.equal(await toplevel(dir), dir);
  assert.equal(await toplevel(f.external), f.external);
  const listed = parseWorktrees((await git("-C", moved.main, "worktree", "list", "--porcelain")).stdout);
  assert.deepEqual(listed.filter(row => !row.prunable).map(row => row.path).sort(), [...Object.values(moved), f.external].sort());
  assert.equal(listed.find(row => row.path === moved.locked).locked, true);
  assert.equal(listed.filter(row => row.prunable).length, 1);

  await run("rollback");
  for (const dir of [f.main, f.sibling, f.locked, f.external]) assert.equal(await toplevel(dir), dir);
});

test("existing targets and a busy cwd stop the migration before anything moves", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.to, "group/repo-feature"), { recursive: true });
  const inner = path.join(f.sibling, "inner");
  await git("-C", f.main, "worktree", "add", "-q", "-b", "inner", inner);
  const plan = await planMigration({ roots: [f.main], fromRoot: f.from, toRoot: f.to, out: path.join(f.root, "plan") });
  assert.deepEqual(plan.blockers, [`target exists: ${path.join(f.to, "group/repo-feature")}`, `nested move source: ${inner} is inside ${f.sibling}`]);
  await rm(path.join(f.to), { recursive: true });
  await git("-C", f.main, "worktree", "remove", inner);

  const busyPlan = await planMigration({ roots: [f.main], fromRoot: f.from, toRoot: f.to, out: path.join(f.root, "plan-busy") });
  assert.deepEqual(busyPlan.blockers, []);
  const migrate = path.join(busyPlan.out, "migrate.sh");
  await assert.rejects(execute("/bin/sh", [migrate], { cwd: f.sibling }), error => error.code === 2 && /busy: /.test(error.stderr));
  assert.equal(await toplevel(f.main), f.main);
  assert.match(await readFile(migrate, "utf8"), /worktree repair/);
});
