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

import { errorMessage } from "#shared/error-message.ts";
import { requireValue } from "#shared/required-value.ts";

const DEFAULT_MIN_AGE_DAYS = 14;
const DENO_JSON_PATH = new URL("../deno.json", import.meta.url).pathname;

interface VersionInfo {
  publishedAt: Date;
  version: string;
}

interface UpgradeResult {
  currentSpec: string;
  currentVersion: string | null;
  error: string | null;
  name: string;
  newPublishedAt: Date | null;
  newVersion: string | null;
  registry: "npm" | "jsr";
  skippedNewer: string | null;
}

interface AvailableUpgrade extends UpgradeResult {
  newPublishedAt: Date;
  newVersion: string;
}

function parseArgs(): { dryRun: boolean; minAgeDays: number } {
  let dryRun = false;
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  for (const arg of Deno.args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--min-age-days=")) {
      minAgeDays = Number.parseInt(arg.slice("--min-age-days=".length), 10);
      if (Number.isNaN(minAgeDays) || minAgeDays < 0) {
        console.error("Invalid --min-age-days value");
        Deno.exit(1);
      }
    }
  }
  return { dryRun, minAgeDays };
}

/** Extract the base version from a specifier like ^0.17.0, ^5, ~1.2, or 1 */
function parseVersionSpec(spec: string): {
  prefix: string;
  version: string;
} | null {
  const match = spec.match(/^([~^]?)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  const prefix = requireValue(match[1], "Version prefix capture is missing");
  const major = requireValue(match[2], "Version major capture is missing");
  const minor = match[3] ?? "0";
  const patch = match[4] ?? "0";
  return { prefix, version: `${major}.${minor}.${patch}` };
}

const versionParts = (version: string): [number, number, number] => {
  const parts = version.split(".");
  if (parts.length !== 3) throw new Error(`Invalid version: ${version}`);
  return [
    Number(requireValue(parts[0], `Invalid version: ${version}`)),
    Number(requireValue(parts[1], `Invalid version: ${version}`)),
    Number(requireValue(parts[2], `Invalid version: ${version}`)),
  ];
};

function compareVersions(a: string, b: string): number {
  const [majorA, minorA, patchA] = versionParts(a);
  const [majorB, minorB, patchB] = versionParts(b);
  if (majorA !== majorB) return majorA - majorB;
  if (minorA !== minorB) return minorA - minorB;
  return patchA - patchB;
}

async function fetchNpmVersions(pkg: string): Promise<VersionInfo[]> {
  const resp = await fetch(`https://registry.npmjs.org/${pkg}`);
  if (!resp.ok) {
    throw new Error(`npm registry returned ${resp.status} for ${pkg}`);
  }
  const data = await resp.json();
  const time = data.time as Record<string, string>;
  const versions: VersionInfo[] = [];
  for (const [ver, dateStr] of Object.entries(time)) {
    if (ver === "created" || ver === "modified") continue;
    // Skip pre-release versions
    if (/[-+]/.test(ver)) continue;
    if (!/^\d+\.\d+\.\d+$/.test(ver)) continue;
    versions.push({ publishedAt: new Date(dateStr), version: ver });
  }
  return versions;
}

async function fetchJsrVersions(
  scope: string,
  name: string,
): Promise<VersionInfo[]> {
  const resp = await fetch(
    `https://jsr.io/api/scopes/${scope}/packages/${name}/versions`,
  );
  if (!resp.ok) {
    throw new Error(`JSR API returned ${resp.status} for @${scope}/${name}`);
  }
  const raw = await resp.json();
  const data = (Array.isArray(raw) ? raw : (raw.items ?? [])) as Array<{
    version: string;
    createdAt: string;
  }>;
  const versions: VersionInfo[] = [];
  for (const entry of data) {
    if (/[-+]/.test(entry.version)) continue;
    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) continue;
    versions.push({
      publishedAt: new Date(entry.createdAt),
      version: entry.version,
    });
  }
  return versions;
}

/**
 * Split an "npm:"/"jsr:" specifier into its package name and version range.
 * Returns an error string when the specifier is malformed or unrecognized.
 */
function parsePackageSpecifier(
  specifier: string,
): { pkgName: string; versionRange: string } | { error: string } {
  if (!specifier.startsWith("npm:") && !specifier.startsWith("jsr:")) {
    return { error: "unknown registry" };
  }
  const withoutPrefix = specifier.slice(4);
  const atIdx = withoutPrefix.lastIndexOf("@");
  if (atIdx <= 0) {
    return { error: "no version specifier found" };
  }
  return {
    pkgName: withoutPrefix.slice(0, atIdx),
    versionRange: withoutPrefix.slice(atIdx + 1),
  };
}

/** Fetch all stable versions for a package from its registry. */
function fetchVersionsFor(
  registry: "npm" | "jsr",
  pkgName: string,
): Promise<VersionInfo[]> {
  if (registry === "npm") {
    return fetchNpmVersions(pkgName);
  }
  const withoutAt = pkgName.startsWith("@") ? pkgName.slice(1) : pkgName;
  const slashIndex = withoutAt.indexOf("/");
  if (slashIndex <= 0 || slashIndex === withoutAt.length - 1) {
    throw new Error(`Invalid JSR package name: ${pkgName}`);
  }
  return fetchJsrVersions(
    withoutAt.slice(0, slashIndex),
    withoutAt.slice(slashIndex + 1),
  );
}

async function checkUpgrade(
  name: string,
  specifier: string,
  cutoffDate: Date,
): Promise<UpgradeResult> {
  const result: UpgradeResult = {
    currentSpec: specifier,
    currentVersion: null,
    error: null,
    name,
    newPublishedAt: null,
    newVersion: null,
    registry: specifier.startsWith("npm:") ? "npm" : "jsr",
    skippedNewer: null,
  };

  try {
    const parsedSpecifier = parsePackageSpecifier(specifier);
    if ("error" in parsedSpecifier) {
      result.error = parsedSpecifier.error;
      return result;
    }
    const { pkgName, versionRange } = parsedSpecifier;

    const parsed = parseVersionSpec(versionRange);
    if (!parsed) {
      result.error = `can't parse version spec: ${versionRange}`;
      return result;
    }
    result.currentVersion = parsed.version;

    const allVersions = await fetchVersionsFor(result.registry, pkgName);

    // Sort all stable versions descending — no semver range filtering,
    // we want the latest version overall (like `deno outdated --update --latest`)
    const sorted = allVersions.sort((a, b) =>
      compareVersions(b.version, a.version),
    );

    const latest = sorted[0];
    if (latest === undefined) {
      result.error = "no versions found";
      return result;
    }

    // Latest version that's old enough
    const safe = sorted.find((v) => v.publishedAt <= cutoffDate);

    if (!safe || compareVersions(safe.version, result.currentVersion) <= 0) {
      // Already at or ahead of the latest safe version
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
    result.error = errorMessage(e);
    return result;
  }
}

const hasUpgrade = (result: UpgradeResult): result is AvailableUpgrade => {
  if ((result.newVersion === null) !== (result.newPublishedAt === null)) {
    throw new Error(`Incomplete upgrade result for ${result.name}`);
  }
  return result.newVersion !== null;
};

async function main() {
  const { dryRun, minAgeDays } = parseArgs();
  const cutoffDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

  console.log(
    `\nSafe upgrade: only versions published before ${cutoffDate
      .toISOString()
      .slice(0, 10)} (${minAgeDays}+ days old)`,
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

  const upgrades = results.filter(hasUpgrade);
  const errors = results.filter((r) => r.error !== null);
  const upToDate = results.filter(
    (r) => r.newVersion === null && r.error === null,
  );

  printUpToDate(upToDate);
  printUpgrades(upgrades, minAgeDays);
  printErrors(errors);

  if (upgrades.length === 0) {
    console.log("Everything is up to date!");
  } else if (!dryRun) {
    await applyUpgrades(upgrades);
  }
}

function printUpToDate(upToDate: UpgradeResult[]): void {
  if (upToDate.length === 0) return;
  console.log(`Up to date (${upToDate.length}):`);
  for (const r of upToDate) {
    console.log(`  ${r.name} @ ${r.currentVersion}`);
  }
  console.log("");
}

function printUpgrades(upgrades: AvailableUpgrade[], minAgeDays: number): void {
  if (upgrades.length === 0) return;
  console.log(`Upgrades available (${upgrades.length}):`);
  for (const r of upgrades) {
    const age = Math.floor(
      (Date.now() - r.newPublishedAt.getTime()) / (1000 * 60 * 60 * 24),
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

function printErrors(errors: UpgradeResult[]): void {
  if (errors.length === 0) return;
  console.log(`Errors (${errors.length}):`);
  for (const r of errors) {
    console.log(`  ${r.name}: ${r.error}`);
  }
  console.log("");
}

async function applyUpgrades(upgrades: AvailableUpgrade[]): Promise<void> {
  let denoJsonText = await Deno.readTextFile(DENO_JSON_PATH);
  for (const r of upgrades) {
    // Replace the full specifier, updating to ^newVersion
    const oldSpec = r.currentSpec;
    const versionPart = oldSpec.slice(oldSpec.lastIndexOf("@") + 1);
    const newSpec = oldSpec.replace(versionPart, `^${r.newVersion}`);
    denoJsonText = denoJsonText.replace(
      JSON.stringify(oldSpec),
      JSON.stringify(newSpec),
    );
  }
  await Deno.writeTextFile(DENO_JSON_PATH, denoJsonText);
  console.log(`Updated deno.json with ${upgrades.length} upgrade(s)`);
  console.log("Run 'deno task precommit' to verify everything still works");
}

main();
