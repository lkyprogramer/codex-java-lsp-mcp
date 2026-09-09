import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolvedPathWithinRepo } from "../java-index-file-parse.js";
import type {
  IndexedReadRange,
  IndexedReadRangeResult,
  JavaCallSiteFact,
  JavaFileBundle,
  JavaMethodFacts,
  SourcePosition,
  SourceRange
} from "../index-types.js";
import type { FactsReader } from "../facts-reader.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";

export type ReadRangeDeps = {
  store: FactsReader;
  repoRoot: string;
  toRelative(inputPath: string): string;
};

const EXTREME_METHOD_LINES = 300;
const EXTREME_METHOD_WINDOW_LINES = 40;
const READ_RANGE_MERGE_GAP_LINES = 3;
const METHODLESS_TYPE_MAX_LINES = 80;
const SIBLING_CALLEE_MAX = 2;
const SIBLING_CALLEE_NEAR_LINES = 80;

type UnlocatedReadRange = Omit<IndexedReadRange, "range">;

function relativePathOf(deps: ReadRangeDeps, inputPath: string): string {
  const relative = deps.toRelative(inputPath);
  return relative.length > 0 ? relative : inputPath.replaceAll("\\", "/");
}

export async function queryReadRanges(
  deps: ReadRangeDeps,
  requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>
): Promise<IndexedReadRangeResult[]> {
  const resolvedRepoRoot = await realpath(deps.repoRoot).catch(() => path.resolve(deps.repoRoot));
  return Promise.all(requests.map(async request => {
    try {
      const relative = relativePathOf(deps, request.file);
      const absolute = path.resolve(deps.repoRoot, relative);
      const readablePath = await resolvedPathWithinRepo(absolute, resolvedRepoRoot);
      if (!readablePath) return { file: request.file, ranges: [] };
      const content = await readFile(readablePath, "utf8");
      const positions = request.positions.length > 0 ? request.positions : [{ line: 1, column: 1 }];
      const bundle = relative.endsWith(".java") ? deps.store.files([relative])[0] : undefined;
      const resource = bundle ? undefined : deps.store.myBatisResource(relative);
      const java = bundle ? javaReadRanges(bundle, positions) : { ranges: [] as UnlocatedReadRange[], extremeMethod: false };
      const xmlRanges = !bundle && resource ? xmlReadRanges(resource, positions) : [];
      const unmerged = java.ranges.length > 0 || xmlRanges.length > 0
        ? [...java.ranges, ...xmlRanges]
        : positions.map(position => fallbackReadRange(position));
      const starts = lineStartOffsets(content);
      const ranges = mergeWorkerReadRanges(unmerged).map(range => ({
        ...range,
        range: sourceRangeForLines(content, starts, range.startLine, range.endLine),
        estimatedBytes: utf8BytesForLines(content, starts, range.startLine, range.endLine)
      }));
      return { file: request.file, ranges, ...(java.extremeMethod ? { extremeMethod: true } : {}) };
    } catch {
      return { file: request.file, ranges: [] };
    }
  }));
}

function javaReadRanges(bundle: JavaFileBundle, positions: SourcePosition[]): { ranges: UnlocatedReadRange[]; extremeMethod: boolean } {
  const ranges: UnlocatedReadRange[] = [];
  const headerTypes = new Set<string>();
  const emittedMethods = new Set<string>();
  let extremeMethod = false;
  const emitMethod = (method: JavaMethodFacts): void => {
    if (emittedMethods.has(method.methodId)) return;
    emittedMethods.add(method.methodId);
    const endLine = methodRangeEnd(method.range, method.bodyRange);
    if (endLine - method.range.start.line + 1 > EXTREME_METHOD_LINES) {
      extremeMethod = true;
      ranges.push({
        startLine: method.range.start.line,
        endLine: Math.min(endLine, method.range.start.line + EXTREME_METHOD_WINDOW_LINES - 1),
        kind: "method",
        estimatedBytes: 0
      });
      ranges.push({
        startLine: Math.max(method.range.start.line + EXTREME_METHOD_WINDOW_LINES, endLine - EXTREME_METHOD_WINDOW_LINES + 1),
        endLine,
        kind: "method",
        estimatedBytes: 0
      });
    } else {
      ranges.push({ startLine: method.range.start.line, endLine, kind: "method", estimatedBytes: 0 });
    }
    const owner = bundle.types.find(type => type.typeId === method.ownerTypeId);
    if (owner && !headerTypes.has(owner.typeId)) {
      ranges.push(typeHeaderRange(owner.range));
      headerTypes.add(owner.typeId);
    }
  };
  for (const position of positions) {
    const method = bundle.methods
      .filter(item => rangeContainsLine(item.range, position.line))
      .sort((left, right) => right.range.start.line - left.range.start.line)[0];
    if (method) {
      emitMethod(method);
      for (const sibling of sameOwnerCallees(bundle, method)) emitMethod(sibling);
      continue;
    }
    const owner = bundle.types
      .filter(type => rangeContainsLine(type.range, position.line))
      .sort((left, right) => right.range.start.line - left.range.start.line)[0];
    if (owner) {
      ranges.push(typeReadRange(bundle, owner));
      headerTypes.add(owner.typeId);
    } else {
      ranges.push(fallbackReadRange(position));
    }
  }
  return { ranges, extremeMethod };
}

function sameOwnerCallees(bundle: JavaFileBundle, method: JavaMethodFacts): JavaMethodFacts[] {
  const selectedEnd = methodRangeEnd(method.range, method.bodyRange);
  const siblings = bundle.methods.filter(item =>
    item.methodId !== method.methodId
    && item.ownerTypeId === method.ownerTypeId
    && !item.constructor
    && item.range.start.line > method.range.start.line
    && item.range.start.line - selectedEnd <= SIBLING_CALLEE_NEAR_LINES
  );
  const callees: JavaMethodFacts[] = [];
  for (const site of method.callSites) {
    if (!isUnqualifiedOrThisCall(site)) continue;
    const matches = siblings.filter(item => item.name === site.name && item.parameters.length === site.arity);
    if (matches.length !== 1) continue;
    const callee = matches[0]!;
    if (!callees.some(item => item.methodId === callee.methodId)) callees.push(callee);
    if (callees.length >= SIBLING_CALLEE_MAX) break;
  }
  return callees;
}

function isUnqualifiedOrThisCall(site: JavaCallSiteFact): boolean {
  if (site.kind !== "METHOD_INVOCATION") return false;
  const receiver = site.receiverText?.trim();
  return !receiver || receiver === "this";
}

function xmlReadRanges(resource: MyBatisMapperResourceFacts, positions: SourcePosition[]): UnlocatedReadRange[] {
  const ranges: UnlocatedReadRange[] = [];
  for (const position of positions) {
    const statement = resource.statements.find(item => item.range && rangeContainsLine(item.range, position.line));
    if (statement?.range) {
      ranges.push({
        startLine: statement.range.start.line,
        endLine: statement.range.end.line,
        kind: "xml-statement",
        estimatedBytes: 0
      });
      continue;
    }
    const resultMap = resource.resultMaps.find(item => item.range && rangeContainsLine(item.range, position.line));
    if (resultMap?.range) {
      ranges.push({
        startLine: resultMap.range.start.line,
        endLine: resultMap.range.end.line,
        kind: "xml-resultMap",
        estimatedBytes: 0
      });
      continue;
    }
    ranges.push(fallbackReadRange(position));
  }
  return ranges;
}

function methodRangeEnd(range: SourceRange, bodyRange: SourceRange | undefined): number {
  return Math.max(range.end.line, bodyRange?.end.line ?? 0);
}

function typeReadRange(bundle: JavaFileBundle, owner: JavaFileBundle["types"][number]): UnlocatedReadRange {
  const instanceMethods = bundle.methods.filter(method => method.ownerTypeId === owner.typeId && !method.constructor);
  if (instanceMethods.length === 0) {
    return {
      startLine: owner.range.start.line,
      endLine: Math.min(Math.max(owner.range.end.line, owner.range.start.line), owner.range.start.line + METHODLESS_TYPE_MAX_LINES - 1),
      kind: "type",
      estimatedBytes: 0
    };
  }
  return typeHeaderRange(owner.range);
}

function rangeContainsLine(range: SourceRange, line: number): boolean {
  return range.start.line <= line && line <= range.end.line;
}

function typeHeaderRange(range: SourceRange): UnlocatedReadRange {
  return {
    startLine: range.start.line,
    endLine: Math.min(range.end.line, range.start.line + 12),
    kind: "type",
    estimatedBytes: 0
  };
}

function fallbackReadRange(position: SourcePosition): UnlocatedReadRange {
  return {
    startLine: Math.max(1, position.line - 10),
    endLine: Math.max(1, position.line + 22),
    kind: "fallback",
    estimatedBytes: 0
  };
}

function mergeWorkerReadRanges(ranges: UnlocatedReadRange[]): UnlocatedReadRange[] {
  const merged: UnlocatedReadRange[] = [];
  for (const current of [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)) {
    const previous = merged.at(-1);
    if (previous && current.startLine <= previous.endLine + READ_RANGE_MERGE_GAP_LINES + 1) {
      previous.endLine = Math.max(previous.endLine, current.endLine);
      previous.kind = previous.kind === "method" || current.kind !== "method" ? previous.kind : current.kind;
      previous.kinds = [...new Set([...(previous.kinds ?? [previous.kind]), ...(current.kinds ?? [current.kind])])];
    } else {
      merged.push({ ...current, kinds: [...new Set(current.kinds ?? [current.kind])] });
    }
  }
  return merged;
}

function lineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function utf8BytesForLines(content: string, starts: readonly number[], startLine: number, endLine: number): number {
  const start = starts[Math.min(Math.max(startLine - 1, 0), starts.length - 1)]!;
  const end = endLine < starts.length ? starts[endLine]! : content.length;
  return Buffer.byteLength(content.slice(start, Math.max(start, end)), "utf8");
}

function sourceRangeForLines(content: string, starts: readonly number[], startLine: number, endLine: number): SourceRange {
  const startOffset = starts[Math.min(Math.max(startLine - 1, 0), starts.length - 1)]!;
  const endOffset = endLine < starts.length ? starts[endLine]! : content.length;
  return {
    start: sourcePositionAtOffset(starts, startOffset),
    end: sourcePositionAtOffset(starts, Math.max(startOffset, endOffset))
  };
}

function sourcePositionAtOffset(starts: readonly number[], offset: number): SourcePosition {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low]! + 1 };
}
