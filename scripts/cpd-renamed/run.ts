/**
 * The rename-blind copy detector's testable core. Given the pairs jscpd found
 * (the entry script runs jscpd itself), keep only the pairs whose two sides
 * are the same code with different words, and fail on any pair the registry
 * does not carry. See `scripts/cpd-renamed.ts` for how jscpd is invoked and
 * `docs/test-duplication.md` for the policy.
 */

import { fromFileUrl } from "@std/path";
import * as v from "valibot";
import { sha256Hex } from "#scripts/checksum.ts";
import { SYNTAX_WORDS } from "#scripts/syntax-words.ts";

/** The repository root as a filesystem path for a module that sits at its
 * top level. URL pathnames keep percent escapes, which breaks project paths
 * holding spaces, so decode through `fromFileUrl`. */
export const repoRootFrom = (moduleUrl: URL): string =>
  fromFileUrl(new URL("../", moduleUrl)).replace(/\/$/, "");

/** A syntax word keeps its own shape only in keyword position. It is a
 * member name — masked like any other word — when it follows a property-access
 * dot or sits in an object-key slot before a colon (`{ delete: item }` reads
 * the same as `{ archive: item }`). The label keywords `case` and `default`
 * also take a colon, so they stay keywords. */
const isKeywordUse = (word: string, offset: number, full: string): boolean => {
  if (full.slice(0, offset).trimEnd().endsWith(".")) return false;
  if (word === "case" || word === "default") return true;
  return !full
    .slice(offset + word.length)
    .trimStart()
    .startsWith(":");
};

export const skeleton = (code: string): string =>
  code
    .replace(/[A-Za-z0-9_$'"]+/g, (word, offset: number) =>
      SYNTAX_WORDS.has(word) && isKeywordUse(word, offset, code) ? word : "§",
    )
    .replace(/\s+/g, "");

/** How equal two clone sides are. "words" means the punctuation shape matches
 * and only word-shaped tokens differ. */
export type CloneKind = "identical" | "words" | "different";

export const cloneKind = (a: string, b: string): CloneKind => {
  const first = a.trim();
  const second = b.trim();
  if (first === second) return "identical";
  return skeleton(first) === skeleton(second) ? "words" : "different";
};

/** The first word of a statement, which names what the statement is. */
const head = (statement: string): string => {
  const limit = statement.search(/[\s{]/);
  return limit === -1 ? statement : statement.slice(0, limit);
};

/** Import blocks are the one sanctioned repeat in this repository, so a span
 * that only names imports is not a finding. A span counts as an import span
 * when every statement in it either closes with a `from "…"` module specifier
 * or is an import member fragment: bare names, braces, and commas whose head
 * word is either a plain name or an import-syntax word. An executable
 * shorthand (`return { a, b };`) heads with a control keyword, so it is not
 * exempt. */
const memberFragment = /^[A-Za-z0-9_$\s{},"']*$/;

/** The words import member lists legitimately start with. */
const importSyntaxHeads = new Set(["import", "type", "from", "of", "in"]);

export const isImportSpan = (code: string): boolean => {
  const statements = code
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
  return (
    statements.length > 0 &&
    statements.every(
      (statement) =>
        /from\s+["'][^"']+["']$/.test(statement) ||
        (memberFragment.test(statement) &&
          (importSyntaxHeads.has(head(statement)) ||
            !SYNTAX_WORDS.has(head(statement)))),
    )
  );
};

/** One side of a pair for hashing: where it sits and what it says. */
export type CloneSide = { file: string; snippet: string };

/** Windows checkouts keep carriage returns, which a hash must not see: the
 * registry records LF-only snippets. */
const lfOnly = (text: string): string => text.replace(/\r\n/g, "\n");

/** A stable identity for a pair: the hash of both files and both snippets.
 * Line numbers drift, so they stay out; the files stay in, so the same
 * snippets copied into new files read as a new pair that needs its own
 * review. Edit either side and the entry goes stale on purpose. */
export const pairHash = async (
  first: CloneSide,
  second: CloneSide,
): Promise<string> =>
  await sha256Hex(
    new TextEncoder().encode(
      `${first.file}\n${lfOnly(first.snippet.trim())}\n<==>\n${second.file}\n${lfOnly(second.snippet.trim())}`,
    ),
  );

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

const allowedCloneSchema = v.object({
  first: v.pipe(v.string(), v.nonEmpty()),
  firstStart: v.number(),
  hash: v.pipe(v.string(), v.nonEmpty()),
  reason: v.pipe(v.string(), v.nonEmpty()),
  second: v.pipe(v.string(), v.nonEmpty()),
  secondStart: v.number(),
});

/** One pair the scan holds: where it sits, its identity, and both snippets. */
export type Finding = ClonePlace & {
  kind: CloneKind;
  firstSnippet: string;
  secondSnippet: string;
};

export type JscpdSide = { name: string; start: number; end: number };
export type JscpdDuplicate = { firstFile: JscpdSide; secondFile: JscpdSide };

/** Resolve a reported name against the directories names may be relative to.
 * The entry names every file relative to the repo root, prefixed with its scan
 * root's word, so one name resolves to exactly one file. */
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
  /** Absolute directory the reported names resolve against (the repo root). */
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
      hash: await pairHash(
        { file: dup.firstFile.name, snippet: first },
        { file: dup.secondFile.name, snippet: second },
      ),
      kind,
      second: dup.secondFile.name,
      secondSnippet: second.trim(),
      secondStart: dup.secondFile.start,
    });
  }
  return findings;
};

const loadRegistry = (registryFile: string): AllowedClone[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(registryFile));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const result = v.safeParse(v.array(allowedCloneSchema), parsed);
  if (!result.success) {
    // A hand-edited entry with no reason would otherwise ride its hash through
    // the check as a silent exemption, so refuse the whole file.
    throw new Error(
      `registry entries are malformed in ${registryFile}: ${result.issues[0].message}`,
    );
  }
  return result.output as AllowedClone[];
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
    const pending = next.filter((entry) =>
      entry.reason.startsWith("pending"),
    ).length;
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
