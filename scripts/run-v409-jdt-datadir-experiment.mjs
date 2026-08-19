#!/usr/bin/env node
// input: a tiny Maven repo root and a real JDT LS binary.
// output: whether a stopped-session pom.xml edit caused M2E to re-import on the
//         next start that reused the same dataDir.
// pos: V4-09 experiment. Does not add a fingerprint expiry layer; it only
//      records whether Eclipse M2E already covers the stopped-session case.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JdtlsSession } from "../dist/jdtls-session.js";
import { DeadlineBudget } from "../dist/runtime/deadline-budget.js";

function parseCli(args) {
  const options = {
    repoRoot: undefined,
    output: undefined,
    timeoutMs: 90_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo-root") options.repoRoot = args[++index];
    else if (arg === "--output") options.output = args[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(args[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.repoRoot) throw new Error("--repo-root is required");
  return options;
}

function importSignals(logText) {
  const patterns = [
    /Updating Maven project/i,
    /Importing Maven project/i,
    /Project configuration is up to date/i,
    /Refreshing Maven model/i,
    /Could not update project/i,
    /Buildship/i
  ];
  return patterns.flatMap(pattern => {
    const matches = logText.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
    return matches;
  });
}

async function runSession(repoRoot, timeoutMs, label) {
  const session = new JdtlsSession(repoRoot);
  const startedAt = Date.now();
  try {
    await session.ensureStarted(DeadlineBudget.fromTimeout(timeoutMs));
    await session.waitForProgressIdle(Math.max(1, timeoutMs - (Date.now() - startedAt)));
    const status = session.status();
    return {
      label,
      dataDir: status.dataDir,
      logFile: status.logFile,
      state: status.state,
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    await session.stop();
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = path.resolve(cli.repoRoot);
  const pomPath = path.join(repoRoot, "pom.xml");
  const originalPom = await readFile(pomPath, "utf8");
  const first = await runSession(repoRoot, cli.timeoutMs, "initial-import");
  const firstLog = await readFile(first.logFile, "utf8").catch(() => "");
  const dependency = `  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
`;
  const mutatedPom = originalPom.includes("<dependencies>")
    ? originalPom.replace("</dependencies>", "    <dependency>\n      <groupId>junit</groupId>\n      <artifactId>junit</artifactId>\n      <version>4.13.2</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>")
    : originalPom.replace("</project>", `${dependency}</project>`);
  await writeFile(pomPath, mutatedPom);
  const second = await runSession(repoRoot, cli.timeoutMs, "reuse-after-stopped-pom-edit");
  const secondLog = await readFile(second.logFile, "utf8").catch(() => "");
  await writeFile(pomPath, originalPom);
  const firstSignals = importSignals(firstLog);
  const secondSignals = importSignals(secondLog.slice(firstLog.length));
  const reusedSameDataDir = first.dataDir === second.dataDir;
  const m2eReimported = secondSignals.some(line => /Updating Maven project|Importing Maven project|Refreshing Maven model/i.test(line));
  const m2eSaidUpToDate = secondSignals.some(line => /Project configuration is up to date/i.test(line));
  const report = {
    schemaVersion: "v4-09-jdt-datadir-experiment/v1",
    repoRoot,
    reusedSameDataDir,
    first,
    second,
    firstSignals,
    secondSignals,
    m2eReimported,
    m2eSaidUpToDate,
    conclusion: !reusedSameDataDir
      ? "INCONCLUSIVE_DATA_DIR_CHANGED"
      : m2eReimported
        ? "M2E_COVERS_STOPPED_SESSION_POM_EDIT"
        : m2eSaidUpToDate
          ? "M2E_DECLARED_UP_TO_DATE"
          : "NO_M2E_SIGNAL_GAP_OR_QUIET_LOG"
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (cli.output) {
    await mkdir(path.dirname(cli.output), { recursive: true });
    await writeFile(cli.output, text);
  }
  process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
