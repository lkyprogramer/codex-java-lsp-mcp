// Synthetic acceptance entry only. The owner launcher preloads its lock guard.
import { closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { MacFSEvents } from "../dist/mac-platform/fsevents.js";
const root = process.argv[2];
const events = [];
let stream;
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  try {
    let result;
    if (command.op === "start") {
      stream = await MacFSEvents.start(root, event => { if (events.length >= 4096) throw new Error("fixture event budget exceeded"); events.push(event); });
      result = await stream.ready;
    } else if (command.op === "fence") result = { fence: await stream.fence(5000), events: [...events] };
    else if (command.op === "stop") { await stream.stop(5000); result = { closed: true }; }
    else if (command.op === "close-parent-fd") { closeSync(4); result = { parentFdClosed: true }; }
    else if (command.op === "exit") { process.stdout.write(JSON.stringify({ id: command.id, result: { exiting: true } }) + "\n"); break; }
    else throw new Error("unknown fixture command");
    process.stdout.write(JSON.stringify({ id: command.id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ id: command.id, error: String(error) }) + "\n"); process.exitCode = 1; break; }
}
if (stream) await stream.stop(5000);
