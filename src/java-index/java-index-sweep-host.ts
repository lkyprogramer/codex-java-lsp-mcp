import { Worker } from "node:worker_threads";
import {
  isSweepWorkerResponse,
  validateSweepParsedFiles,
  type SweepParsedFile,
  type SweepWorkerCommand
} from "./java-index-sweep-protocol.js";
import type { DiscoveredJavaFile } from "./manifest.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class JavaIndexSweepHost {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private opened = false;

  async ensureOpen(repoRoot: string): Promise<void> {
    if (this.opened) return;
    const worker = new Worker(new URL("./java-index-sweep-worker.js", import.meta.url));
    this.worker = worker;
    worker.on("message", value => this.handleMessage(value));
    worker.on("error", error => this.failAll(error));
    worker.on("exit", code => {
      if (this.pending.size === 0) return;
      this.failAll(new Error(`sweep worker exited with code ${code}`));
    });
    const opened = await this.request({ type: "OPEN", repoRoot });
    if (!opened || typeof opened !== "object" || (opened as { type?: string }).type !== "OPENED") {
      throw new Error("sweep worker OPEN did not acknowledge");
    }
    this.opened = true;
  }

  async parseChunk(files: DiscoveredJavaFile[], generation: number): Promise<SweepParsedFile[]> {
    if (!this.opened) throw new Error("sweep host is not open");
    const value = await this.request({ type: "PARSE_CHUNK", generation, files });
    if (!value || typeof value !== "object" || (value as { type?: string }).type !== "PARSED") {
      throw new Error("sweep worker PARSE_CHUNK returned an unexpected value");
    }
    return validateSweepParsedFiles((value as { files: unknown }).files);
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      if (this.opened) await this.request({ type: "CLOSE" }).catch(() => undefined);
    } finally {
      this.opened = false;
      this.worker = undefined;
      this.failAll(new Error("sweep worker closed"));
      await worker.terminate().catch(() => undefined);
    }
  }

  private request(command: SweepWorkerCommand): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("sweep worker is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...command, id });
    });
  }

  private handleMessage(value: unknown): void {
    if (!isSweepWorkerResponse(value)) {
      this.failAll(new Error("sweep worker sent a malformed response"));
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.ok) pending.resolve(value.value);
    else pending.reject(new Error(value.error.message));
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
