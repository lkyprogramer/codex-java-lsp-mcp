// input: Tool selectors, aliases, cwd, and Git worktree metadata.
// output: Effective repo root plus LSP enablement decision.
// pos: Single root/worktree resolver shared by server and hook gate.
//      WorktreeIdentityCache is the only owner of Git common-dir discovery.
import { existsSync } from "node:fs";
import path from "node:path";
import { AliasRegistry, type ProjectAliasConfig } from "./alias-registry.js";
import { canonicalPath, isWithin } from "./path-utils.js";
import { findRepoRoot } from "./repo-layout.js";
import { WorktreeIdentityCache, type WorktreeIdentity } from "./worktree-identity.js";

export type RepoSelector = {
  projectId?: string;
  repoRoot?: string;
  file?: string;
  files?: string[];
  anchors?: Array<{ file: string }>;
};

export type RepoResolverOptions = {
  cwdFallback: "allow" | "reject";
};

export type RootSource = "explicit" | "projectId" | "cwd" | "inferred";

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
  rootSource: RootSource;
  repoHash: string;
  aliases: string[];
  layoutProfile: "ddd-gradle" | "maven-reactor" | "generic-java";
  lsp: LspEnablement;
  worktree: WorktreeIdentity;
};

export class RepoResolver {
  private readonly options: RepoResolverOptions;
  private readonly identities: WorktreeIdentityCache;

  constructor(
    private readonly registry: AliasRegistry,
    options: Partial<RepoResolverOptions> | WorktreeIdentityCache = {},
    identities?: WorktreeIdentityCache
  ) {
    if (options instanceof WorktreeIdentityCache) {
      this.options = { cwdFallback: "allow" };
      this.identities = options;
    } else {
      this.options = { cwdFallback: "allow", ...options };
      this.identities = identities ?? new WorktreeIdentityCache();
    }
  }

  cwdFallbackPolicy(): RepoResolverOptions["cwdFallback"] {
    return this.options.cwdFallback;
  }

  async resolve(selector: RepoSelector): Promise<ResolvedRepo> {
    await this.registry.reloadIfChanged();
    const resolvedRoot = this.resolveRoot(selector);
    const repoRoot = canonicalPath(resolvedRoot.repoRoot);
    const worktree = await this.identities.resolve(repoRoot);
    const matchingAliases = this.registry.aliases().filter(alias => alias.root === repoRoot);
    return {
      repoRoot,
      rootSource: resolvedRoot.source,
      repoHash: worktree.repoHash,
      aliases: matchingAliases.map(alias => alias.id),
      layoutProfile: matchingAliases[0]?.layoutProfile || inferLayoutProfile(repoRoot),
      lsp: await this.resolveEnablementFromIdentity(worktree),
      worktree
    };
  }

  async resolveEnablement(repoRoot: string): Promise<LspEnablement> {
    await this.registry.reloadIfChanged();
    return this.resolveEnablementFromIdentity(await this.identities.resolve(repoRoot));
  }

  private async resolveEnablementFromIdentity(identity: WorktreeIdentity): Promise<LspEnablement> {
    const repoRoot = identity.repoRoot;
    const enabledAliases = this.registry.aliases().filter(alias => alias.lspEnabled);
    const direct = deepestWithin(enabledAliases, repoRoot);
    if (direct) {
      return {
        enabled: true,
        matchedBy: "direct-root",
        configuredRoot: direct.root,
        effectiveRepoRoot: repoRoot
      };
    }

    if (identity.gitCommonDir) {
      const familyMatches: ProjectAliasConfig[] = [];
      for (const alias of enabledAliases) {
        const aliasIdentity = await this.identities.resolve(alias.root);
        if (aliasIdentity.gitCommonDir === identity.gitCommonDir) familyMatches.push(alias);
      }
      if (familyMatches.length === 1) {
        return {
          enabled: true,
          matchedBy: "git-worktree-family",
          configuredRoot: familyMatches[0]!.root,
          effectiveRepoRoot: repoRoot
        };
      }
      if (familyMatches.length > 1) {
        return {
          enabled: false,
          matchedBy: "conflict",
          effectiveRepoRoot: repoRoot,
          reason: "Multiple enabled aliases share this Git common-dir; configure this worktree explicitly."
        };
      }
    }

    const disabled = deepestWithin(this.registry.aliases().filter(alias => !alias.lspEnabled), repoRoot);
    return {
      enabled: false,
      matchedBy: disabled ? "disabled" : "unregistered",
      configuredRoot: disabled?.root,
      effectiveRepoRoot: repoRoot,
      reason: disabled ? "Project alias is registered with lspEnabled=false." : "Project root is not LSP-enabled.",
      enableHint: `./register-alias.sh --enable-lsp <id> ${repoRoot}`
    };
  }

  private resolveRoot(selector: RepoSelector): { repoRoot: string; source: RootSource } {
    if (this.options.cwdFallback === "reject" && selector.repoRoot && selector.projectId) {
      throw new Error("repoRoot and projectId are mutually exclusive in daemon mode.");
    }
    let resolved: { repoRoot: string; source: RootSource };
    if (selector.repoRoot) {
      if (this.options.cwdFallback === "reject" && !path.isAbsolute(selector.repoRoot)) {
        throw new Error("Daemon mode requires repoRoot to be an absolute path.");
      }
      resolved = { repoRoot: findRepoRoot(selector.repoRoot), source: "explicit" };
    } else if (selector.projectId) {
      const alias = this.registry.findById(selector.projectId);
      if (!alias) {
        throw new Error(`Unknown projectId: ${selector.projectId}`);
      }
      resolved = { repoRoot: findRepoRoot(alias.root), source: "projectId" };
    } else {
      const file = selectorFiles(selector)[0];
      if (file) {
        if (this.options.cwdFallback === "reject" && !path.isAbsolute(file)) {
          throw new Error("Daemon mode requires repoRoot/projectId when file paths are relative.");
        }
        const absoluteFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
        resolved = { repoRoot: findRepoRoot(path.dirname(absoluteFile)), source: "inferred" };
      } else {
        if (this.options.cwdFallback === "reject") {
          throw new Error("Daemon mode requires an explicit repoRoot, projectId, or absolute file.");
        }
        resolved = { repoRoot: findRepoRoot(process.cwd()), source: "cwd" };
      }
    }
    if (this.options.cwdFallback === "reject") {
      assertSelectorFilesWithinRoot(resolved.repoRoot, selectorFiles(selector));
    }
    return resolved;
  }
}

function selectorFiles(selector: RepoSelector): string[] {
  return [
    ...(selector.file ? [selector.file] : []),
    ...(selector.files || []),
    ...(selector.anchors || []).map(anchor => anchor.file)
  ];
}

function assertSelectorFilesWithinRoot(repoRoot: string, files: string[]): void {
  for (const file of files) {
    const candidate = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
    if (!isWithin(repoRoot, candidate)) {
      throw new Error(`Selector file is outside resolved repo root: ${file}`);
    }
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
