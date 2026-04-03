/**
 * Safe dependency upgrade script.
 *
 * Only upgrades to versions published at least 2 weeks ago,
 * reducing risk from supply chain attacks via newly-hijacked packages.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net scripts/safe-upgrade.ts
 *   deno run --allow-read --allow-write --allow-net scripts/safe-upgrade.ts --dry-run
 *   deno run --allow-read --allow-write --allow-net scripts/safe-upgrade.ts --min-age-days=30
 */

const DEFAULT_MIN_AGE_DAYS = 14;
const DENO_JSON_PATH = new URL("../deno.json", import.meta.url).pathname;

interface VersionInfo {
  version: string;
  publishedAt: Date;
}

interface UpgradeResult {
  name: string;
  registry: "npm" | "jsr";
  currentSpec: string;
  currentVersion: string | null;
  newVersion: string | null;
  newPublishedAt: Date | null;
  skippedNewer: string | null;
  error: string | null;
}

function parseArgs(): { dryRun: boolean; minAgeDays: number } {
  let dryRun = false;
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  for (const arg of Deno.args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--min-age-days=")) {
      minAgeDays = parseInt(arg.split("=")[1], 10);
      if (isNaN(minAgeDays) || minAgeDays < 0) {
        console.error("Invalid --min-age-days value");
        Deno.exit(1);
      }
    }
  }
  return { dryRun, minAgeDays };
}

/** Extract the base version from a specifier like ^0.17.0 or ~1.2.3 or 1.2.3 */
function parseVersionRange(spec: string): {
  prefix: string;
  major: number;
  minor: number;
  patch: number;
} | null {
  const match = spec.match(/^([~^]?)(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    prefix: match[1],
    major: parseInt(match[2], 10),
    minor: parseInt(match[3], 10),
    patch: parseInt(match[4], 10),
  };
}

/** Check if a version satisfies a ^/~ range */
function satisfiesRange(
  version: string,
  range: { prefix: string; major: number; minor: number; patch: number },
): boolean {
  const v = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!v) return false;
  const [, majStr, minStr, patStr] = v;
  const maj = parseInt(majStr, 10);
  const min = parseInt(minStr, 10);
  const pat = parseInt(patStr, 10);

  // Must be >= the range base
  if (
    maj < range.major ||
    (maj === range.major && min < range.minor) ||
    (maj === range.major && min === range.minor && pat < range.patch)
  ) {
    return false;
  }

  if (range.prefix === "^") {
    // ^major.minor.patch: allow changes that don't modify the leftmost non-zero
    if (range.major !== 0) return maj === range.major;
    if (range.minor !== 0) return maj === 0 && min === range.minor;
    return maj === 0 && min === 0 && pat === range.patch;
  }
  if (range.prefix === "~") {
    return maj === range.major && min === range.minor;
  }
  // Exact version (no prefix) — only match exact
  return maj === range.major && min === range.minor && pat === range.patch;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function fetchNpmVersions(pkg: string): Promise<VersionInfo[]> {
  const resp = await fetch(`https://registry.npmjs.org/${pkg}`);
  if (!resp.ok) throw new Error(`npm registry returned ${resp.status} for ${pkg}`);
  const data = await resp.json();
  const time = data.time as Record<string, string>;
  const versions: VersionInfo[] = [];
  for (const [ver, dateStr] of Object.entries(time)) {
    if (ver === "created" || ver === "modified") continue;
    // Skip pre-release versions
    if (/[-+]/.test(ver)) continue;
    if (!/^\d+\.\d+\.\d+$/.test(ver)) continue;
    versions.push({ version: ver, publishedAt: new Date(dateStr) });
  }
  return versions;
}

async function fetchJsrVersions(scope: string, name: string): Promise<VersionInfo[]> {
  const resp = await fetch(`https://jsr.io/api/scopes/${scope}/packages/${name}/versions`);
  if (!resp.ok) throw new Error(`JSR API returned ${resp.status} for @${scope}/${name}`);
  const data = await resp.json() as Array<{ version: string; createdAt: string }>;
  const versions: VersionInfo[] = [];
  for (const entry of data) {
    if (/[-+]/.test(entry.version)) continue;
    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) continue;
    versions.push({ version: entry.version, publishedAt: new Date(entry.createdAt) });
  }
  return versions;
}

async function checkUpgrade(
  name: string,
  specifier: string,
  cutoffDate: Date,
): Promise<UpgradeResult> {
  const result: UpgradeResult = {
    name,
    registry: specifier.startsWith("npm:") ? "npm" : "jsr",
    currentSpec: specifier,
    currentVersion: null,
    newVersion: null,
    newPublishedAt: null,
    skippedNewer: null,
    error: null,
  };

  try {
    let pkgName: string;
    let versionRange: string;

    if (specifier.startsWith("npm:")) {
      // npm:@scope/name@version or npm:name@version
      const withoutPrefix = specifier.slice(4);
      const atIdx = withoutPrefix.lastIndexOf("@");
      if (atIdx <= 0) {
        result.error = "no version specifier found";
        return result;
      }
      pkgName = withoutPrefix.slice(0, atIdx);
      versionRange = withoutPrefix.slice(atIdx + 1);
    } else if (specifier.startsWith("jsr:")) {
      const withoutPrefix = specifier.slice(4);
      const atIdx = withoutPrefix.lastIndexOf("@");
      if (atIdx <= 0) {
        result.error = "no version specifier found";
        return result;
      }
      pkgName = withoutPrefix.slice(0, atIdx);
      versionRange = withoutPrefix.slice(atIdx + 1);
    } else {
      result.error = "unknown registry";
      return result;
    }

    const range = parseVersionRange(versionRange);
    if (!range) {
      result.error = `can't parse version range: ${versionRange}`;
      return result;
    }
    result.currentVersion = `${range.major}.${range.minor}.${range.patch}`;

    let allVersions: VersionInfo[];
    if (result.registry === "npm") {
      allVersions = await fetchNpmVersions(pkgName);
    } else {
      const [scope, name] = pkgName.replace("@", "").split("/");
      allVersions = await fetchJsrVersions(scope, name);
    }

    // Find versions that satisfy the range
    const compatible = allVersions
      .filter((v) => satisfiesRange(v.version, range))
      .sort((a, b) => compareVersions(b.version, a.version)); // descending

    if (compatible.length === 0) {
      result.error = "no compatible versions found";
      return result;
    }

    // Latest version overall
    const latest = compatible[0];

    // Latest version that's old enough
    const safe = compatible.find((v) => v.publishedAt <= cutoffDate);

    if (!safe || safe.version === result.currentVersion) {
      // Already at the latest safe version
      return result;
    }

    result.newVersion = safe.version;
    result.newPublishedAt = safe.publishedAt;

    // Note if we skipped a newer version because it's too fresh
    if (latest.version !== safe.version) {
      result.skippedNewer = latest.version;
    }

    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}

async function main() {
  const { dryRun, minAgeDays } = parseArgs();
  const cutoffDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

  console.log(
    `\nSafe upgrade: only versions published before ${cutoffDate.toISOString().slice(0, 10)} (${minAgeDays}+ days old)`,
  );
  if (dryRun) console.log("DRY RUN — no changes will be written\n");
  else console.log("");

  const denoJson = JSON.parse(await Deno.readTextFile(DENO_JSON_PATH));
  const imports = denoJson.imports as Record<string, string>;

  // Collect external dependencies (npm: and jsr:)
  const deps = Object.entries(imports).filter(
    ([, spec]) => spec.startsWith("npm:") || spec.startsWith("jsr:"),
  );

  console.log(`Found ${deps.length} external dependencies to check\n`);

  const results = await Promise.all(
    deps.map(([name, spec]) => checkUpgrade(name, spec, cutoffDate)),
  );

  const upgrades = results.filter((r) => r.newVersion !== null);
  const errors = results.filter((r) => r.error !== null);
  const upToDate = results.filter((r) => r.newVersion === null && r.error === null);

  // Print results
  if (upToDate.length > 0) {
    console.log(`Up to date (${upToDate.length}):`);
    for (const r of upToDate) {
      console.log(`  ${r.name} @ ${r.currentVersion}`);
    }
    console.log("");
  }

  if (upgrades.length > 0) {
    console.log(`Upgrades available (${upgrades.length}):`);
    for (const r of upgrades) {
      const age = Math.floor(
        (Date.now() - r.newPublishedAt!.getTime()) / (1000 * 60 * 60 * 24),
      );
      console.log(
        `  ${r.name}: ${r.currentVersion} -> ${r.newVersion} (${age} days old)`,
      );
      if (r.skippedNewer) {
        console.log(
          `    ⚠ skipped ${r.skippedNewer} (too recent, < ${minAgeDays} days)`,
        );
      }
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const r of errors) {
      console.log(`  ${r.name}: ${r.error}`);
    }
    console.log("");
  }

  // Apply upgrades
  if (upgrades.length > 0 && !dryRun) {
    let denoJsonText = await Deno.readTextFile(DENO_JSON_PATH);
    for (const r of upgrades) {
      // Replace the version in the specifier string
      const oldSpec = r.currentSpec;
      const range = parseVersionRange(
        oldSpec.slice(oldSpec.lastIndexOf("@") + 1),
      )!;
      const newSpec = oldSpec.replace(
        `${range.prefix}${range.major}.${range.minor}.${range.patch}`,
        `${range.prefix}${r.newVersion}`,
      );
      denoJsonText = denoJsonText.replace(
        JSON.stringify(oldSpec),
        JSON.stringify(newSpec),
      );
    }
    await Deno.writeTextFile(DENO_JSON_PATH, denoJsonText);
    console.log(`Updated deno.json with ${upgrades.length} upgrade(s)`);
    console.log("Run 'deno task precommit' to verify everything still works");
  } else if (upgrades.length === 0) {
    console.log("Everything is up to date!");
  }
}

main();
