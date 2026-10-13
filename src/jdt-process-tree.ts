// input: A pid this daemon spawned, the start identity captured at spawn, and the JDT -data directory.
// output: SIGKILL of that pid and of descendants whose command line contains the same directory.
// pos: Last-resort reaper used when ChildProcess.kill does not make the OS process exit.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { processStartIdentityForPid } from "./repo-ownership-lease.js";

export type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

export function listProcesses(): ProcessRow[] {
  let output = "";
  try {
    // -ww: macOS ps otherwise clips command at the terminal width, and JDT puts
    // `-data <workspace>` after a classpath long enough to lose the marker.
    output = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

export function processCommand(pid: number): string | undefined {
  return listProcesses().find(row => row.pid === pid)?.command;
}

/**
 * True only while `pid` is still the process captured as `expectedIdentity`.
 * A missing pid is not alive. An unreadable identity stays "alive" so a
 * transient `ps` failure cannot be treated as permission to spawn another JDT.
 */
export function ownedPidStillAlive(pid: number, expectedIdentity: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || !expectedIdentity) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  const current = processStartIdentityForPid(pid);
  if (!current) return true;
  return current === expectedIdentity;
}

/**
 * `undefined` means `ps` has not shown this pid yet. That is not a collision:
 * a missing command must not be treated as "some other workspace".
 */
export function classifyWorkspaceCommand(
  command: string | undefined,
  dataDir: string
): "owned" | "collision" | "unseen" {
  if (command === undefined) return "unseen";
  return command.includes(dataDir) ? "owned" : "collision";
}

export function isJdtWorkspaceMarker(pathMarker: string): boolean {
  return path.isAbsolute(pathMarker)
    && pathMarker.length >= 16
    && pathMarker.includes(`${path.sep}workspace`);
}

/**
 * Kill `rootPid` only when its start identity still matches and its command
 * line contains `pathMarker`. Descendants are killed only when their command
 * line contains the same marker, so a pid collision cannot take an unrelated
 * process down. Returns true when a signal was sent.
 */
export function killOwnedProcessTree(rootPid: number, pathMarker: string, expectedIdentity: string): boolean {
  if (!Number.isInteger(rootPid) || rootPid <= 1 || rootPid === process.pid) return false;
  if (!isJdtWorkspaceMarker(pathMarker) || !expectedIdentity) return false;
  if (!ownedPidStillAlive(rootPid, expectedIdentity)) return false;
  const rows = listProcesses();
  const root = rows.find(row => row.pid === rootPid);
  if (!root || !commandOwnsWorkspace(root.command, pathMarker)) return false;
  const victims = descendants(rows, rootPid)
    .filter(row => row.pid !== process.pid && commandOwnsWorkspace(row.command, pathMarker));
  for (const row of victims.reverse()) signal(row.pid);
  signal(rootPid);
  return true;
}

function commandOwnsWorkspace(command: string, pathMarker: string): boolean {
  return command.includes(pathMarker);
}

function descendants(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: ProcessRow[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    found.push(row);
    pending.push(...(children.get(row.pid) ?? []));
  }
  return found;
}

function signal(pid: number): void {
  if (pid === process.pid || pid <= 1) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone, or not ours. The caller confirms death with the identity check.
  }
}
