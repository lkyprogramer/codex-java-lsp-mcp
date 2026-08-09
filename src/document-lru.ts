// input: file/text pairs a JdtlsSession wants JDT to have open, plus lease
//        release signals once each caller's LSP request settles.
// output: bounded open-document state (max 64 by default), didOpen/didChange/
//         didClose notifications for the caller to forward to the JDT
//         connection, and status counters for java_status.
import { toFileUri } from "./repo-layout.js";

export type DocumentLease = {
  readonly uri: string;
  readonly version: number;
  release(): void;
};

export type DocumentLruStatus = {
  maxOpen: number;
  open: number;
  pinned: number;
  evictions: number;
  evictionDeferred: number;
  closes: number;
  retainedTextBytes: number;
};

export type DocumentLruOptions = {
  maxOpen?: number;
  notify(method: string, params: unknown): void;
};

type OpenDocumentEntry = {
  uri: string;
  version: number;
  text: string;
  pins: number;
  lastUsedAt: number;
};

const DEFAULT_MAX_OPEN = 64;

/**
 * Same-uri opens and updates are serialized here (not just deduped by caller) because
 * Task 33's per-operation gateway split means 2-3 concurrent requests for the
 * same position each call acquire() independently; without joining, each
 * would race its own didOpen/didChange and corrupt the version JDT sees -
 * this exact race caused a measured 1.4-1.6x three-repo P95 regression
 * before it was joined at the JdtlsSession layer (see openDocument() there,
 * predating this class). Serializing here keeps that guarantee while still
 * giving every caller its own independently-released pin.
 */
export class DocumentLru {
  private readonly maxOpen: number;
  private readonly notify: (method: string, params: unknown) => void;
  private readonly entries = new Map<string, OpenDocumentEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private sequence = 0;
  private evictions = 0;
  private evictionDeferred = 0;
  private closes = 0;

  constructor(options: DocumentLruOptions) {
    this.maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN;
    this.notify = options.notify;
  }

  async acquire(file: string, text: string): Promise<DocumentLease> {
    const uri = toFileUri(file);
    const entry = await this.serialize(uri, () => this.sync(uri, text));
    // Pin before evicting: eviction only ever considers pins===0 entries, so
    // bumping first guarantees the entry this exact call just resolved can
    // never be the victim of its own eviction pass (only possible when every
    // other entry is also pinned - see the maxOpen=1, two-pinned-callers test).
    entry.pins += 1;
    entry.lastUsedAt = this.sequence += 1;
    this.evict();
    let released = false;
    return {
      uri,
      version: entry.version,
      release: () => {
        if (released) return;
        released = true;
        entry.pins = Math.max(0, entry.pins - 1);
        this.evict();
      }
    };
  }

  has(file: string): boolean {
    return this.entries.has(toFileUri(file));
  }

  /** Cached text for a URI without acquiring a lease or bumping recency - used for read-only lookups like diagnostic filtering. */
  textForUri(uri: string): string | undefined {
    return this.entries.get(uri)?.text;
  }

  /**
   * Refreshes text only when the document is already open. Calls for the same
   * URI are serialized so two filesystem changes cannot reuse one inflight
   * promise and silently drop the later text/version.
   */
  async updateIfOpen(file: string, text: string): Promise<boolean> {
    const uri = toFileUri(file);
    return this.serialize(uri, () => {
      if (!this.entries.has(uri)) return false;
      this.sync(uri, text);
      return true;
    });
  }

  delete(file: string): void {
    const uri = toFileUri(file);
    const entry = this.entries.get(uri);
    if (!entry) return;
    this.entries.delete(uri);
    this.closes += 1;
    this.notify("textDocument/didClose", { textDocument: { uri: entry.uri } });
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      this.closes += 1;
      this.notify("textDocument/didClose", { textDocument: { uri: entry.uri } });
    }
    this.entries.clear();
    this.inflight.clear();
  }

  status(): DocumentLruStatus {
    let pinned = 0;
    let retainedTextBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.pins > 0) pinned += 1;
      retainedTextBytes += Buffer.byteLength(entry.text, "utf8");
    }
    return {
      maxOpen: this.maxOpen,
      open: this.entries.size,
      pinned,
      evictions: this.evictions,
      evictionDeferred: this.evictionDeferred,
      closes: this.closes,
      retainedTextBytes
    };
  }

  private serialize<T>(uri: string, action: () => T): Promise<T> {
    const previous = this.inflight.get(uri);
    let operation: Promise<T>;
    if (previous) {
      operation = previous.then(action, action);
    } else {
      try {
        operation = Promise.resolve(action());
      } catch (error) {
        operation = Promise.reject(error);
      }
    }
    const tail = operation.then(() => undefined, () => undefined);
    this.inflight.set(uri, tail);
    void tail.then(() => {
      if (this.inflight.get(uri) === tail) this.inflight.delete(uri);
    });
    return operation;
  }

  private sync(uri: string, text: string): OpenDocumentEntry {
    const existing = this.entries.get(uri);
    if (!existing) {
      const entry: OpenDocumentEntry = { uri, version: 1, text, pins: 0, lastUsedAt: this.sequence += 1 };
      this.entries.set(uri, entry);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "java", version: 1, text }
      });
      return entry;
    }
    if (existing.text !== text) {
      existing.version += 1;
      existing.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }]
      });
    }
    return existing;
  }

  /**
   * A 64-entry linear scan is simpler than a heap and this cap keeps it
   * cheap; called after every new open and every release so a document that
   * only becomes evictable once its last pin drops is retried immediately.
   */
  private evict(): void {
    while (this.entries.size > this.maxOpen) {
      let victim: OpenDocumentEntry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.pins > 0) continue;
        if (!victim || entry.lastUsedAt < victim.lastUsedAt) {
          victim = entry;
        }
      }
      if (!victim) {
        this.evictionDeferred += 1;
        return;
      }
      this.entries.delete(victim.uri);
      this.evictions += 1;
      this.closes += 1;
      this.notify("textDocument/didClose", { textDocument: { uri: victim.uri } });
    }
  }
}
