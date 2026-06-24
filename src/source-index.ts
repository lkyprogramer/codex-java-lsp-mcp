// input: Java source files in the current repo/worktree.
// output: Lightweight cached source facts for agent routing.
// pos: Fast source index used before bounded LSP enrichment.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LspDocumentSymbol } from "./jdtls-session.js";
import { classifyPath, normalizeRepoFile, repoCacheRoot } from "./repo-layout.js";

export type JavaMethodFact = {
  name: string;
  line: number;
  endLine: number;
};

export type JavaSourceFacts = {
  absolutePath: string;
  path?: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  packageName?: string;
  typeName?: string;
  kind?: "class" | "interface" | "record" | "enum";
  implementsTypes: string[];
  extendsType?: string;
  annotations: string[];
  methods: JavaMethodFact[];
  factSource: "regex" | "documentSymbol";
  confirmedAt?: string;
};

type CacheEntry = {
  mtimeMs: number;
  size: number;
  facts: JavaSourceFacts;
};

export type SourceIndexStatus = {
  entries: number;
  hits: number;
  misses: number;
  regexFacts: number;
  documentSymbolFacts: number;
  snapshotAgeMs?: number;
  dirtyCount: number;
  warmIndexPending: number;
  warmIndexFailed: number;
};

type FileRecord = Omit<JavaSourceFacts, "methods"> & {
  mtimeMs: number;
  size: number;
  batchId: string;
};

type SymbolRecord = JavaMethodFact & {
  file: string;
  batchId: string;
  kind: "method";
  factSource: JavaSourceFacts["factSource"];
  confirmedAt?: string;
};

export class SourceIndex {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly snapshotDir: string;
  private readonly filesPath: string;
  private readonly symbolsPath: string;
  private readonly metaPath: string;
  private snapshotUpdatedAt?: number;
  private totalFileRecords = 0;
  private warmIndexPending = 0;
  private warmIndexFailed = 0;
  private hits = 0;
  private misses = 0;
  private dirtyCountCache?: { computedAt: number; value: number };

  constructor(private readonly repoRoot: string) {
    this.snapshotDir = repoCacheRoot(repoRoot);
    this.filesPath = path.join(this.snapshotDir, "source-index.files.jsonl");
    this.symbolsPath = path.join(this.snapshotDir, "source-index.symbols.jsonl");
    this.metaPath = path.join(this.snapshotDir, "source-index.meta.json");
    this.loadSnapshot();
  }

  status(): SourceIndexStatus {
    let regexFacts = 0;
    let documentSymbolFacts = 0;
    for (const entry of this.cache.values()) {
      if (entry.facts.factSource === "documentSymbol") {
        documentSymbolFacts += 1;
      } else {
        regexFacts += 1;
      }
    }
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      regexFacts,
      documentSymbolFacts,
      snapshotAgeMs: this.snapshotUpdatedAt ? Date.now() - this.snapshotUpdatedAt : undefined,
      dirtyCount: this.dirtyCount(),
      warmIndexPending: this.warmIndexPending,
      warmIndexFailed: this.warmIndexFailed
    };
  }

  beginWarmIndex(): void {
    this.warmIndexPending += 1;
  }

  finishWarmIndex(success: boolean): void {
    this.warmIndexPending = Math.max(0, this.warmIndexPending - 1);
    if (!success) {
      this.warmIndexFailed += 1;
    }
  }

  factsFor(inputFile: string): JavaSourceFacts {
    const absolutePath = normalizeRepoFile(this.repoRoot, inputFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Java source file does not exist: ${inputFile}`);
    }
    const stat = statSync(absolutePath);
    const cached = this.cache.get(absolutePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.hits += 1;
      return cached.facts;
    }
    this.misses += 1;
    const facts = parseJavaSource(this.repoRoot, absolutePath, readFileSync(absolutePath, "utf8"));
    this.cache.set(absolutePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      facts
    });
    this.persist(stat.mtimeMs, stat.size, facts);
    return facts;
  }

  methodAt(inputFile: string, line: number): JavaMethodFact | undefined {
    const facts = this.factsFor(inputFile);
    return [...facts.methods]
      .filter(method => method.line <= line && line <= method.endLine)
      .sort((left, right) => right.line - left.line)[0]
      || [...facts.methods].filter(method => method.line <= line).sort((left, right) => right.line - left.line)[0];
  }

  findImplementers(typeName: string): JavaSourceFacts[] {
    const simpleName = typeName.slice(typeName.lastIndexOf(".") + 1);
    return [...this.cache.values()]
      .map(entry => entry.facts)
      .filter(facts => facts.typeName !== simpleName && implementsOrExtends(facts, simpleName))
      .sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  }

  upsertDocumentSymbols(inputFile: string, symbols: LspDocumentSymbol[]): JavaSourceFacts {
    const absolutePath = normalizeRepoFile(this.repoRoot, inputFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Java source file does not exist: ${inputFile}`);
    }
    const stat = statSync(absolutePath);
    const baseFacts = parseJavaSource(this.repoRoot, absolutePath, readFileSync(absolutePath, "utf8"));
    const flattened = flattenDocumentSymbols(symbols);
    const typeSymbol = flattened.find(symbol => isTypeSymbol(symbol.kind));
    const methods = flattened
      .filter(symbol => isMethodSymbol(symbol.kind))
      .map(symbol => ({
        name: symbol.name,
        line: symbol.range.start.line + 1,
        endLine: Math.max(symbol.range.start.line + 1, symbol.range.end.line + 1)
      }))
      .sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
    const facts: JavaSourceFacts = {
      ...baseFacts,
      typeName: typeSymbol?.name || baseFacts.typeName,
      kind: typeSymbol ? javaKind(typeSymbol.kind) : baseFacts.kind,
      methods: methods.length > 0 ? methods : baseFacts.methods,
      factSource: "documentSymbol",
      confirmedAt: new Date().toISOString()
    };
    this.cache.set(absolutePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      facts
    });
    this.persist(stat.mtimeMs, stat.size, facts);
    return facts;
  }

  private loadSnapshot(): void {
    if (!existsSync(this.filesPath) || !existsSync(this.symbolsPath)) {
      return;
    }
    try {
      const files = new Map<string, FileRecord>();
      for (const record of readJsonLines<FileRecord>(this.filesPath)) {
        files.set(record.absolutePath, record);
        this.totalFileRecords += 1;
      }
      const symbolsByFile = new Map<string, JavaMethodFact[]>();
      for (const symbol of readJsonLines<SymbolRecord>(this.symbolsPath)) {
        const file = files.get(symbol.file);
        if (!file || file.batchId !== symbol.batchId) {
          continue;
        }
        const symbols = symbolsByFile.get(symbol.file) || [];
        symbols.push({ name: symbol.name, line: symbol.line, endLine: symbol.endLine });
        symbolsByFile.set(symbol.file, symbols);
      }
      for (const file of files.values()) {
        const { mtimeMs, size, batchId: _batchId, ...facts } = file;
        this.cache.set(file.absolutePath, {
          mtimeMs,
          size,
          facts: {
            ...facts,
            methods: symbolsByFile.get(file.absolutePath) || []
          }
        });
      }
      this.snapshotUpdatedAt = existsSync(this.metaPath) ? statSync(this.metaPath).mtimeMs : undefined;
    } catch {
      rmSync(this.filesPath, { force: true });
      rmSync(this.symbolsPath, { force: true });
      rmSync(this.metaPath, { force: true });
      this.cache.clear();
      this.totalFileRecords = 0;
    }
  }

  private persist(mtimeMs: number, size: number, facts: JavaSourceFacts): void {
    mkdirSync(this.snapshotDir, { recursive: true });
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { methods, ...fileFacts } = facts;
    const fileRecord: FileRecord = { ...fileFacts, mtimeMs, size, batchId };
    appendFileSync(this.filesPath, `${JSON.stringify(fileRecord)}\n`);
    const symbolLines = methods.map(method => {
      const symbol: SymbolRecord = {
        ...method,
        file: facts.absolutePath,
        batchId,
        kind: "method",
        factSource: facts.factSource,
        confirmedAt: facts.confirmedAt
      };
      return `${JSON.stringify(symbol)}\n`;
    });
    if (symbolLines.length > 0) {
      appendFileSync(this.symbolsPath, symbolLines.join(""));
    }
    this.totalFileRecords += 1;
    this.snapshotUpdatedAt = Date.now();
    const duplicateRatio = this.duplicateRatio();
    this.writeMeta(duplicateRatio);
    if (duplicateRatio > 0.30 && this.totalFileRecords > this.cache.size + 10) {
      this.compact();
    }
  }

  private compact(): void {
    const filesTmp = `${this.filesPath}.tmp`;
    const symbolsTmp = `${this.symbolsPath}.tmp`;
    writeFileSync(filesTmp, "");
    writeFileSync(symbolsTmp, "");
    this.totalFileRecords = 0;
    for (const entry of this.cache.values()) {
      const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { methods, ...fileFacts } = entry.facts;
      const fileRecord: FileRecord = {
        ...fileFacts,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        batchId
      };
      appendFileSync(filesTmp, `${JSON.stringify(fileRecord)}\n`);
      for (const method of methods) {
        appendFileSync(symbolsTmp, `${JSON.stringify({
          ...method,
          file: entry.facts.absolutePath,
          batchId,
          kind: "method",
          factSource: entry.facts.factSource,
          confirmedAt: entry.facts.confirmedAt
        } satisfies SymbolRecord)}\n`);
      }
      this.totalFileRecords += 1;
    }
    renameSync(filesTmp, this.filesPath);
    renameSync(symbolsTmp, this.symbolsPath);
    this.snapshotUpdatedAt = Date.now();
    this.writeMeta(this.duplicateRatio(), new Date(this.snapshotUpdatedAt).toISOString());
  }

  private writeMeta(duplicateRatio: number, lastCompactedAt?: string): void {
    const updatedAt = this.snapshotUpdatedAt || Date.now();
    writeFileSync(this.metaPath, `${JSON.stringify({
      schemaVersion: 1,
      repoRoot: this.repoRoot,
      updatedAt: new Date(updatedAt).toISOString(),
      files: this.cache.size,
      fileRecords: this.totalFileRecords,
      duplicateRatio,
      lastCompactedAt
    }, null, 2)}\n`);
  }

  private duplicateRatio(): number {
    return this.totalFileRecords === 0 ? 0 : 1 - (this.cache.size / this.totalFileRecords);
  }

  private dirtyCount(): number {
    const now = Date.now();
    if (this.dirtyCountCache && now - this.dirtyCountCache.computedAt < 1000) {
      return this.dirtyCountCache.value;
    }
    let dirty = 0;
    for (const [file, entry] of this.cache.entries()) {
      try {
        const stat = statSync(file);
        if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
          dirty += 1;
        }
      } catch {
        dirty += 1;
      }
    }
    this.dirtyCountCache = { computedAt: now, value: dirty };
    return dirty;
  }
}

function implementsOrExtends(facts: JavaSourceFacts, simpleName: string): boolean {
  return facts.implementsTypes.some(type => sameSimpleType(type, simpleName)) || sameSimpleType(facts.extendsType || "", simpleName);
}

function sameSimpleType(value: string, expected: string): boolean {
  const simple = value.replace(/<.*>/, "").trim().slice(value.lastIndexOf(".") + 1);
  return simple === expected;
}

export function parseJavaSource(repoRoot: string, absolutePath: string, content: string): JavaSourceFacts {
  const context = classifyPath(repoRoot, absolutePath);
  const lines = content.split(/\r?\n/);
  const packageName = content.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m)?.[1];
  const annotations = lines
    .map(line => line.trim())
    .filter(line => /^@[A-Za-z0-9_.]+/.test(line))
    .map(line => line.replace(/\(.*/, ""));
  const typeMatch = content.match(/\b(class|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)([^{;]*)/);
  const typeTail = typeMatch?.[3] || "";
  const implementsTypes = typeTail.match(/\bimplements\s+([A-Za-z0-9_.,\s<>]+)/)?.[1]
    ?.split(",")
    .map(value => value.replace(/<.*>/, "").trim())
    .filter(Boolean) || [];
  const extendsType = typeTail.match(/\bextends\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];

  return {
    absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    packageName,
    typeName: typeMatch?.[2] || path.basename(absolutePath, ".java"),
    kind: typeMatch?.[1] as JavaSourceFacts["kind"] | undefined,
    implementsTypes,
    extendsType,
    annotations,
    methods: parseMethods(lines),
    factSource: "regex"
  };
}

function flattenDocumentSymbols(symbols: LspDocumentSymbol[]): LspDocumentSymbol[] {
  const flattened: LspDocumentSymbol[] = [];
  const visit = (symbol: LspDocumentSymbol) => {
    flattened.push(symbol);
    for (const child of symbol.children || []) {
      visit(child);
    }
  };
  for (const symbol of symbols) {
    visit(symbol);
  }
  return flattened;
}

function isMethodSymbol(kind: number): boolean {
  return kind === 6 || kind === 9 || kind === 12;
}

function isTypeSymbol(kind: number): boolean {
  return kind === 5 || kind === 10 || kind === 11 || kind === 23;
}

function javaKind(kind: number): JavaSourceFacts["kind"] {
  if (kind === 10) {
    return "enum";
  }
  if (kind === 11) {
    return "interface";
  }
  if (kind === 23) {
    return "record";
  }
  return "class";
}

function parseMethods(lines: string[]): JavaMethodFact[] {
  const methods: JavaMethodFact[] = [];
  const methodPattern = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|synchronized|abstract|default|native)\s+)+(?:<[^>]+>\s*)?(?:[A-Za-z_][\w<>\[\].?,\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(methodPattern);
    if (!match || isControlWord(match[1])) {
      continue;
    }
    const blockStart = findSignatureBlockStart(lines, index);
    if (blockStart === undefined) {
      continue;
    }
    methods.push({
      name: match[1],
      line: index + 1,
      endLine: findBlockEnd(lines, blockStart)
    });
  }
  return methods;
}

function findSignatureBlockStart(lines: string[], startIndex: number): number | undefined {
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 12); index += 1) {
    const line = stripLineComment(lines[index]);
    if (line.includes(";")) {
      return undefined;
    }
    if (line.includes("{")) {
      return index;
    }
  }
  return undefined;
}

function findBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const char of stripLineComment(lines[index])) {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth <= 0) {
          return index + 1;
        }
      }
    }
  }
  return Math.min(lines.length, startIndex + 80);
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

function isControlWord(value: string): boolean {
  return new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw"]).has(value);
}

function readJsonLines<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}
