import { positiveInteger } from "./resource-defaults.js";

type Waiter = {
  repoRoot: string;
  resolve: () => void;
};

export class DocumentSymbolLimiter {
  private activeGlobal = 0;
  private readonly activeByRepo = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly globalLimit = positiveInteger(process.env.JAVA_LSP_DOCUMENT_SYMBOL_GLOBAL_CONCURRENCY, 2),
    private readonly perRepoLimit = positiveInteger(process.env.JAVA_LSP_DOCUMENT_SYMBOL_PER_REPO_CONCURRENCY, 1)
  ) {}

  async withSlot<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(repoRoot);
    try {
      return await task();
    } finally {
      this.release(repoRoot);
    }
  }

  status(): { active: number; pending: number; globalLimit: number; perRepoLimit: number } {
    return {
      active: this.activeGlobal,
      pending: this.waiters.length,
      globalLimit: this.globalLimit,
      perRepoLimit: this.perRepoLimit
    };
  }

  private async acquire(repoRoot: string): Promise<void> {
    if (this.tryAcquire(repoRoot)) {
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push({ repoRoot, resolve });
    });
  }

  private release(repoRoot: string): void {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    this.activeByRepo.set(repoRoot, Math.max(0, (this.activeByRepo.get(repoRoot) || 0) - 1));
    this.drain();
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (!this.tryAcquire(waiter.repoRoot)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.resolve();
    }
  }

  private tryAcquire(repoRoot: string): boolean {
    const repoActive = this.activeByRepo.get(repoRoot) || 0;
    if (this.activeGlobal >= this.globalLimit || repoActive >= this.perRepoLimit) {
      return false;
    }
    this.activeGlobal += 1;
    this.activeByRepo.set(repoRoot, repoActive + 1);
    return true;
  }
}

export const documentSymbolLimiter = new DocumentSymbolLimiter();
