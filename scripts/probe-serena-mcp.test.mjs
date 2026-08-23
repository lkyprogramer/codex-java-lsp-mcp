import assert from "node:assert/strict";
import test from "node:test";
import { probeSerenaMcp, SERENA_UVX_FROM } from "./probe-serena-mcp.mjs";

test("serena probe is READY when uvx help succeeds", async () => {
  const result = await probeSerenaMcp({
    execFileImpl: async (file, args) => {
      assert.equal(file, "uvx");
      assert.equal(args[1], SERENA_UVX_FROM);
      return { stdout: "ok" };
    }
  });
  assert.equal(result.status, "READY");
  assert.match(result.command, /serena-mcp-server/);
});

test("serena probe uses pip only after uvx fails, then abandons", async () => {
  const calls = [];
  const result = await probeSerenaMcp({
    execFileImpl: async (file, args) => {
      calls.push([file, ...args].join(" "));
      throw new Error(`${file} missing`);
    }
  });
  assert.equal(result.status, "SERENA_ABANDONED");
  assert.equal(result.command, null);
  assert.equal(result.killCriterion, "old-jin-paired-hit-rate");
  assert.equal(calls[0].startsWith("uvx "), true);
  assert.equal(calls.some(line => line.includes("pip show")), true);
});

test("serena probe is READY when a pip package already exists", async () => {
  const result = await probeSerenaMcp({
    execFileImpl: async (file, args) => {
      if (file === "uvx") throw new Error("uvx missing");
      if (args.includes("serena-mcp-server")) return { stdout: "Name: serena-mcp-server" };
      throw new Error("not installed");
    }
  });
  assert.equal(result.status, "READY");
  assert.equal(result.command, "python3 -m serena-mcp-server");
});
