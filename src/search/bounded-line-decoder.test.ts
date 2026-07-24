import assert from "node:assert/strict";
import test from "node:test";
import { BoundedLineDecoder } from "./bounded-line-decoder.js";

test("splits multiple lines from a single chunk", () => {
  const decoder = new BoundedLineDecoder(1024);
  assert.deepEqual(decoder.push(Buffer.from("a\nb\nc")), ["a", "b"]);
  assert.deepEqual(decoder.finish(), ["c"]);
});

test("keeps a UTF-8 character split across chunk boundaries intact", () => {
  const decoder = new BoundedLineDecoder(1024);
  const encoded = Buffer.from("类型\n", "utf8");
  const first = encoded.subarray(0, 2);
  const second = encoded.subarray(2);

  assert.deepEqual(decoder.push(first), [], "an incomplete character yields no line");
  assert.deepEqual(decoder.push(second), ["类型"]);
});

test("strips a trailing CR so CRLF output parses", () => {
  const decoder = new BoundedLineDecoder(1024);
  assert.deepEqual(decoder.push(Buffer.from("value\r\nnext\r\n")), ["value", "next"]);
});

test("returns nothing for empty input", () => {
  const decoder = new BoundedLineDecoder(1024);
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
  assert.deepEqual(decoder.finish(), []);
});

test("rejects a completed line larger than the cap", () => {
  const decoder = new BoundedLineDecoder(8);
  assert.throws(
    () => decoder.push(Buffer.from("123456789012\n")),
    /exceeded 8 bytes/
  );
});

test("rejects an unterminated buffer that grows past the cap", () => {
  const decoder = new BoundedLineDecoder(8);
  assert.deepEqual(decoder.push(Buffer.from("1234")), []);
  assert.throws(() => decoder.push(Buffer.from("56789")), /exceeded 8 bytes/);
});

test("returns a trailing unterminated record within the cap", () => {
  const decoder = new BoundedLineDecoder(8);
  assert.deepEqual(decoder.push(Buffer.from("done\ntail")), ["done"]);
  assert.deepEqual(decoder.finish(), ["tail"]);
  assert.deepEqual(decoder.finish(), [], "finish drains the buffer");
});
