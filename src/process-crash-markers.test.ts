import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CRASH_MARKER,
  formatCrashMarker,
  installProcessCrashMarkers
} from "./process-crash-markers.js";

test("formatCrashMarker is one JSON line with the stable marker key", () => {
  const line = formatCrashMarker({
    marker: CRASH_MARKER,
    process: "http-daemon",
    event: "uncaughtException",
    pid: 1,
    at: "2026-08-28T00:00:00.000Z",
    name: "Error",
    message: "boom"
  });
  assert.equal(JSON.parse(line).marker, CRASH_MARKER);
  assert.equal(JSON.parse(line).event, "uncaughtException");
});

test("uncaughtException logs a crash marker then exits", () => {
  const fake = new EventEmitter() as EventEmitter & { pid: number; exit: (code: number) => void };
  fake.pid = 42;
  let exited: number | undefined;
  fake.exit = (code: number) => {
    exited = code;
  };
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    installProcessCrashMarkers("http-daemon", fake);
    fake.emit("uncaughtException", new Error("boom"));
  } finally {
    console.error = original;
  }
  assert.equal(exited, 1);
  const payload = JSON.parse(lines[0]!);
  assert.equal(payload.marker, CRASH_MARKER);
  assert.equal(payload.process, "http-daemon");
  assert.equal(payload.event, "uncaughtException");
  assert.equal(payload.pid, 42);
  assert.equal(payload.message, "boom");
});
