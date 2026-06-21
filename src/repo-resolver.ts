// input: Tool selectors, aliases, cwd, and Git worktree metadata.
// output: Effective repo root plus LSP enablement decision.
// pos: Single root/worktree resolver shared by server and hook gate.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { AliasRegistry, type ProjectAliasConfig } from "./alias-registry.js";
import { canonicalPath, isWithin, repoHash } from "./path-utils.js";
import { findRepoRoot } from "./repo-layout.js";

export type RepoSelector = {
  projectId?: string;
  repoRoot?: string;
  file?: string;
  files?: string[];
};

export type LspEnablement = {
  enabled: boolean;
  matchedBy: "direct-root" | "git-worktree-family" | "disabled" | "unregistered" | "conflict";
  configuredRoot?: string;
  effectiveRepoRoot: string;
  reason?: string;
  enableHint?: string;
};

export type ResolvedRepo = {
  repoRoot: string;
  repoHash: string;
  aliases: string[];
  layoutProfile: "ddd-gradle" | "maven-reactor" | "generic-java";
  lsp: LspEnablement;
};

export class RepoResolver {
  constructor(private readonly registry: AliasRegistry) {}

  async resolve(selector: RepoSelector): Promise<ResolvedRepo> {
    await this.registry.reloadIfChanged();
    const repoRoot = canonicalPath(this.resolveRoot(selector));
    const matchingAliases = this.registry.aliases().filter(alias => alias.root === repoRoot);
    return {
      repoRoot,
      repoHash: repoHash(repoRoot),
      aliases: matchingAliases.map(alias => alias.id),
      layoutProfile: matchingAliases[0]?.layoutProfile || inferLayoutProfile(repoRoot),
      lsp: this.resolveEnablement(repoRoot)
    };
  }

  resolveEnablement(repoRoot: string): LspEnablement {
    const canonicalRoot = canonicalPath(repoRoot);
    const enabledAliases = this.registry.aliases().filter(alias => alias.lspEnabled);
    const direct = deepestWithin(enabledAliases, canonicalRoot);
    if (direct) {
      return {
        enabled: true,
        matchedBy: "direct-root",
        configuredRoot: direct.root,
        effectiveRepoRoot: canonicalRoot
      };
    }

    const currentGit = gitWorktree(canonicalRoot);
    if (currentGit) {
      const familyMatches = enabledAliases.filter(alias => {
        const aliasGit = gitWorktree(alias.root);
        return aliasGit && aliasGit.commonDir === currentGit.commonDir;
      });
      if (familyMatches.length === 1) {
        return {
          enabled: true,
          matchedBy: "git-worktree-family",
          configuredRoot: familyMatches[0]!.root,
          effectiveRepoRoot: currentGit.topLevel
        };
      }
      if (familyMatches.length > 1) {
        return {
          enabled: false,
          matchedBy: "conflict",
          effectiveRepoRoot: canonicalRoot,
          reason: "Multiple enabled aliases share this Git common-dir; configure this worktree explicitly."
        };
      }
    }

    const disabled = deepestWithin(this.registry.aliases().filter(alias => !alias.lspEnabled), canonicalRoot);
    return {
      enabled: false,
      matchedBy: disabled ? "disabled" : "unregistered",
      configuredRoot: disabled?.root,
      effectiveRepoRoot: canonicalRoot,
      reason: disabled ? "Project alias is registered with lspEnabled=false." : "Project root is not LSP-enabled.",
      enableHint: `./register-alias.sh --enable-lsp <id> ${canonicalRoot}`
    };
  }

  private resolveRoot(selector: RepoSelector): string {
    if (selector.repoRoot) {
      return findRepoRoot(selector.repoRoot);
    }
    if (selector.projectId) {
      const alias = this.registry.findById(selector.projectId);
      if (!alias) {
        throw new Error(`Unknown projectId: ${selector.projectId}`);
      }
      return findRepoRoot(alias.root);
    }
    const file = selector.file || selector.files?.[0];
    if (file && path.isAbsolute(file)) {
      return findRepoRoot(path.dirname(file));
    }
    return findRepoRoot(process.cwd());
  }
}

function deepestWithin(aliases: ProjectAliasConfig[], repoRoot: string): ProjectAliasConfig | undefined {
  return aliases
    .filter(alias => isWithin(alias.root, repoRoot))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

function inferLayoutProfile(repoRoot: string): "ddd-gradle" | "maven-reactor" | "generic-java" {
  if (existsSync(path.join(repoRoot, "settings.gradle")) || existsSync(path.join(repoRoot, "settings.gradle.kts"))) {
    return existsSync(path.join(repoRoot, "modules")) || existsSync(path.join(repoRoot, "apps")) ? "ddd-gradle" : "generic-java";
  }
  if (existsSync(path.join(repoRoot, "pom.xml"))) {
    return "maven-reactor";
  }
  return "generic-java";
}

function gitWorktree(repoRoot: string): { topLevel: string; commonDir: string } | undefined {
  const topLevel = git(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return undefined;
  }
  const commonDirRaw = git(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!commonDirRaw) {
    return undefined;
  }
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(topLevel, commonDirRaw);
  return {
    topLevel: canonicalPath(topLevel),
    commonDir: canonicalPath(commonDir)
  };
}

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}
