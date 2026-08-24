// input: ~/.config/codex-java-lsp/projects.json.
// output: Reloadable alias and LSP enablement registry.
// pos: Shared registry for MCP server and hook gate.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { canonicalPath } from "./path-utils.js";

const aliasSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1).refine(value => path.isAbsolute(value), {
    message: "root must be an absolute path"
  }),
  lspEnabled: z.boolean().default(false),
  layoutProfile: z.enum(["ddd-gradle", "maven-reactor", "generic-java"]).optional()
});

const configSchema = z.object({
  aliases: z.array(aliasSchema).default([]),
  defaults: z.record(z.string(), z.unknown()).default({})
});

export type ProjectAliasConfig = z.infer<typeof aliasSchema> & {
  root: string;
};

type RegistrySnapshot = {
  aliases: ProjectAliasConfig[];
  defaults: Record<string, unknown>;
  mtimeMs?: number;
  size?: number;
};

export type AliasRegistryStatus = {
  lastReloadError?: string;
  lastReloadErrorAt?: string;
};

export class AliasRegistry {
  private snapshot: RegistrySnapshot = { aliases: [], defaults: {} };
  private loadedOnce = false;
  private lastReloadError?: string;
  private lastReloadErrorAt?: Date;

  constructor(private readonly configPath = defaultConfigPath()) {}

  async reloadIfChanged(): Promise<void> {
    if (!existsSync(this.configPath)) {
      // Deletion is a valid state, not a parse failure: aliases become empty
      // rather than retaining a now-stale last-known-good snapshot.
      this.snapshot = { aliases: [], defaults: {} };
      this.lastReloadError = undefined;
      this.lastReloadErrorAt = undefined;
      return;
    }
    const stat = statSync(this.configPath);
    if (this.snapshot.mtimeMs === stat.mtimeMs && this.snapshot.size === stat.size) {
      return;
    }
    try {
      const parsed = configSchema.parse(JSON.parse(await readFile(this.configPath, "utf8")));
      this.snapshot = {
        aliases: parsed.aliases.map(alias => ({
          ...alias,
          root: canonicalPath(alias.root)
        })),
        defaults: parsed.defaults,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      };
      this.loadedOnce = true;
      this.lastReloadError = undefined;
      this.lastReloadErrorAt = undefined;
    } catch (error) {
      this.lastReloadError = error instanceof Error ? error.message : String(error);
      this.lastReloadErrorAt = new Date();
      // Before any valid config has ever loaded there is no last-known-good
      // to fall back to, so a broken first load must still fail loudly.
      if (!this.loadedOnce) throw error;
    }
  }

  status(): AliasRegistryStatus {
    return {
      lastReloadError: this.lastReloadError,
      lastReloadErrorAt: this.lastReloadErrorAt?.toISOString()
    };
  }

  aliases(): ProjectAliasConfig[] {
    return this.snapshot.aliases;
  }

  defaults(): Record<string, unknown> {
    return this.snapshot.defaults;
  }

  findById(projectId: string): ProjectAliasConfig | undefined {
    return this.snapshot.aliases.find(alias => alias.id === projectId);
  }
}

function defaultConfigPath(): string {
  return process.env.JAVA_LSP_PROJECTS_JSON || path.join(homedir(), ".config", "codex-java-lsp", "projects.json");
}
