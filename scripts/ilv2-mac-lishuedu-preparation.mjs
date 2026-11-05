import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { managedPath, readJson, requireValue, sha256 } from "./ilv2-mac-contracts.mjs";

const mavenFiles = [
  ["lishu-common-dependencies", ["lishu-common-dependencies-1.0.0-SNAPSHOT.pom", "maven-metadata-local.xml"]],
  ["lishu-boot-starter", ["lishu-boot-starter-1.0.0-SNAPSHOT.pom", "lishu-boot-starter-1.0.0-SNAPSHOT.jar", "maven-metadata-local.xml"]]
].flatMap(([artifact, names]) => names.map(name => `com/lishu/common/${artifact}/1.0.0-SNAPSHOT/${name}`));

async function checkedFile(root, relative, record, label) {
  const file = path.join(root, relative);
  requireValue(await managedPath(root, file) === file && (await lstat(file)).isFile(), `${label} must be a canonical file: ${relative}`);
  const bytes = await readFile(file);
  requireValue(bytes.length === record.bytes && sha256(bytes) === record.sha256, `${label} digest mismatch: ${relative}`);
  return { file, bytes };
}

function validateMavenFiles(files) {
  requireValue(Array.isArray(files) && files.length === mavenFiles.length && new Set(files.map(row => row.path)).size === mavenFiles.length
    && mavenFiles.every(file => files.some(row => row.path === file)), "lishuedu Maven manifest must list exactly the BOM and Starter files");
}

// Only isolated preparation seeds Maven. Formal Gradle resolves with its normal Maven repository.
export async function prepareLishueduMavenLocal(plan, root, { stage = false } = {}) {
  const manifestFile = plan.lishueduMavenLocal;
  requireValue(typeof manifestFile === "string" && path.isAbsolute(manifestFile) && await managedPath(root, manifestFile) === manifestFile && (await lstat(manifestFile)).isFile(),
    "lishuedu Maven manifest must belong to this run");
  const bytes = await readFile(manifestFile);
  const manifest = JSON.parse(bytes);
  requireValue(manifest.schema === "ilv2-lishuedu-maven-local/v1", "unsupported lishuedu Maven manifest");
  validateMavenFiles(manifest.files);
  const repository = path.join(plan.ownerHome, ".m2/repository");
  const source = path.join(path.dirname(manifestFile), "repository");
  requireValue(await managedPath(root, source) === source, "lishuedu Maven source repository must be canonical");
  const inputs = [];
  for (const row of manifest.files) {
    const input = await checkedFile(source, row.path, row, "Maven seed");
    const target = path.join(repository, row.path);
    if (stage) {
      requireValue(await managedPath(plan.ownerHome, target) === target, "isolated Maven seed destination must be canonical");
      inputs.push({ target, bytes: input.bytes });
    }
  }
  for (const { target, bytes } of inputs) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  return { repository, inputManifestSha256: sha256(bytes), files: manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
}

export async function verifyPreparedLishuedu(resultFile, { repoRoot, gradleHome, ownerHome, signal }) {
  const result = await readJson(resultFile);
  requireValue(result.schema === "ilv2-gradle-install-prepare-result/v1" && result.status === "PASS"
    && result.projectModel === "PASS" && result.aptModel === "PASS" && result.resourceExit === "PASS", "lishuedu preparation has not passed");
  requireValue(result.artifactManifest?.path === path.join(path.dirname(resultFile), "artifact-manifest.json"), "Gradle artifact manifest path mismatch");
  const manifestBytes = await readFile(result.artifactManifest.path);
  const manifest = JSON.parse(manifestBytes);
  requireValue(sha256(manifestBytes) === result.artifactManifest.sha256 && manifest.schema === "ilv2-prepared-gradle-artifacts/v1"
    && manifest.status === "PASS" && manifest.projectId === "lishuedu" && manifest.repoRoot === repoRoot
    && manifest.gradleHome === gradleHome && manifest.ownerHome === ownerHome, "lishuedu prepared manifest identity mismatch");
  requireValue(typeof manifest.gradleProxyPort === "string" && /^[1-9]\d{0,4}$/.test(manifest.gradleProxyPort)
    && Number(manifest.gradleProxyPort) <= 65535, "invalid prepared Gradle proxy port");
  const repository = path.join(ownerHome, ".m2/repository");
  requireValue(manifest.mavenLocal?.repository === repository && await managedPath(ownerHome, repository) === repository, "Maven repository identity mismatch");
  validateMavenFiles(manifest.mavenLocal.files);
  for (const row of manifest.mavenLocal.files) await checkedFile(repository, row.path, row, "prepared Maven input");
  requireValue(manifest.artifacts.length === result.artifactManifest.count, "Gradle artifact count mismatch");
  const artifactRoot = path.join(gradleHome, "caches/modules-2/files-2.1");
  const artifacts = new Map();
  for (const row of manifest.artifacts) {
    signal?.throwIfAborted();
    requireValue(row.path.startsWith("caches/modules-2/files-2.1/"), "Gradle artifact outside module cache");
    const { file } = await checkedFile(artifactRoot, path.relative(artifactRoot, path.join(gradleHome, row.path)), row, "prepared Gradle artifact");
    artifacts.set(file, row);
  }
  const starter = manifest.mavenLocal.files.find(row => row.path.endsWith(".jar"));
  const starterPath = path.join(repository, starter.path);
  requireValue(manifest.requiredFiles.some(row => row.path === starterPath && row.sha256 === starter.sha256 && row.bytes === starter.bytes),
    "Eclipse model did not use the pinned local Starter JAR");
  requireValue(typeof manifest.appLombok === "string" && artifacts.has(manifest.appLombok)
    && /\/org\.projectlombok\/lombok\/[^/]+\/[^/]+\/lombok-[^/]+\.jar$/.test(manifest.appLombok)
    && result.processorFiles?.includes(manifest.appLombok) && manifest.requiredFiles.some(row => row.path === manifest.appLombok),
    "lishuedu application APT Lombok JAR missing from prepared inputs");
  for (const row of manifest.requiredFiles) {
    signal?.throwIfAborted();
    if (row.path === starterPath) continue;
    const artifact = artifacts.get(row.path);
    if (artifact) {
      requireValue(artifact.sha256 === row.sha256 && artifact.bytes === row.bytes, "prepared model artifact digest mismatch: " + row.path);
    } else {
      const root = row.path.startsWith(gradleHome + path.sep) ? gradleHome : repoRoot;
      await checkedFile(root, path.relative(root, row.path), row, "prepared model artifact");
    }
  }
  const indexRoot = path.join(gradleHome, "jdt-shared-index");
  const index = manifest.jdtJarIndexes;
  requireValue(index?.status === "PASS" && index.directory === indexRoot && index.manifest === path.join(indexRoot, "manifest.json")
    && index.manifestSha256 === result.jdtJarIndexes?.manifestSha256 && await managedPath(gradleHome, index.manifest) === index.manifest,
    "JAR index manifest identity mismatch");
  const indexBytes = await readFile(index.manifest);
  const inventory = JSON.parse(indexBytes);
  requireValue(sha256(indexBytes) === index.manifestSha256 && inventory.schema === "ilv2-prepared-jdt-jar-indexes/v1"
    && inventory.indexes.length === index.count && index.count > 0, "JAR index inventory mismatch");
  for (const row of inventory.indexes) {
    signal?.throwIfAborted();
    const jar = artifacts.get(row.jar.path);
    requireValue(jar?.sha256 === row.jar.sha256 && jar.bytes === row.jar.bytes
      && String((await stat(row.jar.path, { bigint: true })).mtimeNs) === row.jarMtimeNs, "JAR index input drift: " + row.jar.path);
    await checkedFile(indexRoot, row.file, row, "prepared JAR index");
  }
  return { artifactManifestSha256: result.artifactManifest.sha256, mavenFiles: manifest.mavenLocal.files.length,
    artifacts: manifest.artifacts.length, jdtJarIndexes: index.count, indexRoot, appLombok: manifest.appLombok,
    gradleProxyPort: manifest.gradleProxyPort };
}
