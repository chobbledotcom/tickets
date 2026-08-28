/**
 * The rename-blind copy detector's testable core. Given the pairs jscpd found
 * (the entry script runs jscpd itself), keep only the pairs whose two sides
 * are the same code with different words, and fail on any pair the registry
 * does not carry. See `scripts/cpd-renamed.ts` for how jscpd is invoked and
 * `docs/test-duplication.md` for the policy.
 */

import { sha256Hex } from "#scripts/checksum.ts";

/** Words include names, strings, and numbers: everything a rename touches. */
export const skeleton = (code: string): string =>
  code.replace(/[A-Za-z0-9_$'"]+/g, "§").replace(/\s+/g, "");

/** How equal two clone sides are. "words" means the punctuation shape matches
 * and only word-shaped tokens differ. */
export type CloneKind = "identical" | "words" | "different";

export const cloneKind = (a: string, b: string): CloneKind => {
  const first = a.trim();
  const second = b.trim();
  if (first === second) return "identical";
  return skeleton(first) === skeleton(second) ? "words" : "different";
};

/** Import blocks are the one sanctioned repeat in this repository, so a span
 * that only names imports is not a finding. A span counts as an import span
 * when it opens with `import` or closes with a `from "…"` module specifier. */
export const isImportSpan = (code: string): boolean => {
  const trimmed = code.trim();
  return (
    trimmed.startsWith("import ") || /from\s+["'][^"']+["'];?\s*$/.test(trimmed)
  );
};

/** A stable identity for a pair: the hash of both snippets together. Line
 * numbers drift, so the content is the key; edit either side and the entry
 * goes stale on purpose, forcing a fresh review. */
export const pairHash = async (a: string, b: string): Promise<string> =>
  await sha256Hex(new TextEncoder().encode(`${a.trim()}\n<==>\n${b.trim()}`));

/** Where a copy sits: both sides and the content identity of the pair. */
export type ClonePlace = {
  first: string;
  firstStart: number;
  second: string;
  secondStart: number;
  hash: string;
};

/** One reviewed pair. `reason` must say why the repeat is allowed to stay. */
export type AllowedClone = ClonePlace & {
  reason: string;
};

/** One pair the scan holds: where it sits, its identity, and both snippets. */
export type Finding = ClonePlace & {
  kind: CloneKind;
  firstSnippet: string;
  secondSnippet: string;
};

export type JscpdSide = { name: string; start: number; end: number };
export type JscpdDuplicate = { firstFile: JscpdSide; secondFile: JscpdSide };

/** jscpd names each file relative to the scan root it came from, so a name
 * like `src/main.ts` may live under `e2e-payments/`. Try every root. */
export const resolvePath = (roots: string[], name: string): string => {
  const hit = roots.find((root) => {
    try {
      Deno.statSync(`${root}/${name}`);
      return true;
    } catch {
      return false;
    }
  });
  if (hit === undefined) {
    throw new Error(`jscpd reported a file no scan root holds: ${name}`);
  }
  return `${hit}/${name}`;
};

export type CheckOptions = {
  /** Absolute scan roots, in the order jscpd was given them. */
  roots: string[];
  /** The pairs jscpd found, verbatim from its report. */
  duplicates: JscpdDuplicate[];
  /** Path of the registry file (allowed.json). */
  registryFile: string;
  /** Where the check writes its report. */
  output: { log: (line: string) => void };
  /** Rewrite the registry, keeping reasons for pairs that did not change. */
  update?: boolean;
};

const snippetAt = (roots: string[], side: JscpdSide): string =>
  Deno.readTextFileSync(resolvePath(roots, side.name))
    .split("\n")
    .slice(side.start - 1, side.end)
    .join("\n");

/** Read every jscpd pair and keep the ones this scan is about: two sides that
 * are byte-equal or share their whole punctuation shape. Import spans are the
 * one sanctioned repeat, so a pair of them is dropped. */
export const collectFindings = async (
  options: CheckOptions,
): Promise<Finding[]> => {
  const findings: Finding[] = [];
  for (const dup of options.duplicates) {
    const first = snippetAt(options.roots, dup.firstFile);
    const second = snippetAt(options.roots, dup.secondFile);
    if (isImportSpan(first) && isImportSpan(second)) continue;
    const kind = cloneKind(first, second);
    if (kind === "different") continue;
    findings.push({
      first: dup.firstFile.name,
      firstSnippet: first.trim(),
      firstStart: dup.firstFile.start,
      hash: await pairHash(first, second),
      kind,
      second: dup.secondFile.name,
      secondSnippet: second.trim(),
      secondStart: dup.secondFile.start,
    });
  }
  return findings;
};

const loadRegistry = (registryFile: string): AllowedClone[] => {
  try {
    return JSON.parse(Deno.readTextFileSync(registryFile)) as AllowedClone[];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

const describe = (finding: Finding): string => {
  const head = (snippet: string): string =>
    snippet
      .split("\n")
      .slice(0, 3)
      .map((line) => `     ${line}`)
      .join("\n");
  return (
    `${finding.first}:${finding.firstStart} vs ${finding.second}:${finding.secondStart} (${finding.kind})` +
    `\n  A:\n${head(finding.firstSnippet)}\n  B:\n${head(finding.secondSnippet)}`
  );
};

const PENDING =
  "pending review — merge the pair, or say why the repeat is by design";

/** Run the check and return the process exit code. Zero means every word-only
 * copy is carried by the registry and every registry entry still matches a
 * finding. */
export const runRenamedCloneCheck = async (
  options: CheckOptions,
): Promise<number> => {
  const findings = await collectFindings(options);
  const registry = loadRegistry(options.registryFile);
  const known = new Map(registry.map((entry) => [entry.hash, entry]));

  const unlisted = findings.filter((finding) => !known.has(finding.hash));
  const stale = registry.filter(
    (entry) => !findings.some((finding) => finding.hash === entry.hash),
  );

  if (options.update) {
    const next: AllowedClone[] = findings.map(
      ({ first, firstStart, second, secondStart, hash }): AllowedClone => ({
        first,
        firstStart,
        hash,
        reason: known.get(hash)?.reason ?? PENDING,
        second,
        secondStart,
      }),
    );
    Deno.writeTextFileSync(
      options.registryFile,
      `${JSON.stringify(next, null, 2)}\n`,
    );
    const pending = next.filter((entry) => entry.reason === PENDING).length;
    options.output.log(
      `registry rewritten: ${next.length} entries (${pending} pending review)`,
    );
  }

  for (const finding of unlisted) {
    options.output.log(`COPY FOUND: ${describe(finding)}`);
  }
  for (const entry of stale) {
    options.output.log(
      `STALE ENTRY: ${entry.first}:${entry.firstStart} vs ${entry.second}:${entry.secondStart} — pair resolved or changed, delete the entry`,
    );
  }
  options.output.log(
    `${findings.length} word-only copies, ${unlisted.length} new, ${stale.length} stale registry entries.`,
  );
  if (unlisted.length > 0) {
    options.output.log(
      `Two sites spell one code shape with different words. Merge them into one shared mechanism (extract a helper, or curry the parts that differ), then re-run. A registry entry in ${options.registryFile} is allowed only for a repeat that is by design, with the reason written in the entry.`,
    );
  }
  return unlisted.length > 0 || (!options.update && stale.length > 0) ? 1 : 0;
};
