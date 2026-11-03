/**
 * Keep methods flat: find the chains of three or more named calls that repeat
 * at two or more sites in one tree (see "Keep methods flat" in AGENTS.md).
 *
 * A chain that repeats hides one helper. The sites all call `a(b(c(...)))`
 * where one helper says the same thing. The check holds every repeated chain
 * to its recorded site count in `registry.json`, and the count only falls.
 */

import ts from "typescript";
import { joinStrings, map } from "#fp";
import type { Counts } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { blankSpans } from "#scripts/typescript-lex.ts";

/** The fewest methods one chain must name to count. */
const CHAIN_LENGTH = 3;

/** The fewest sites a chain must repeat at to count. */
const REPEAT_LIMIT = 2;

/** One row's chain: where it sits, and the methods it nests, outermost first. */
export interface ChainSite {
  file: string;
  line: number;
  names: readonly string[];
}

/** One row of closing brackets, from its first to its last bracket. */
type Row = { end: number; start: number };

/** The row a chain must close: three closing brackets or more, in one run. */
const BRACKET_ROW = /[)\]}]{3,}/g;

const RULE = "repeated-chain";
const FIX = "write one helper for the chain, and call it from each site";

const UPDATE_COMMAND = "deno task check:call-chains --update";

const REGISTRY = "scripts/check-call-chains/registry.json";

/** Every row of three or more adjacent closing brackets in one file. */
const rowsOf = (content: string): Row[] =>
  [...blankSpans(content, true).matchAll(BRACKET_ROW)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
  }));

/** The method one call names, or null when it names none: a callback and a
 * curried application both name none. */
const calleeName = (call: ts.CallExpression): string | null => {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  return ts.isIdentifier(expression.expression)
    ? `${expression.expression.text}.${expression.name.text}`
    : expression.name.text;
};

/** Whether a node's last bracket sits inside one row. */
const closesInRow = (node: ts.Node, row: Row): boolean =>
  node.end > row.start && node.end <= row.end;

/** The named calls round one call, outermost first, so a curried application
 * keeps the methods it applies. */
const chainRound = (call: ts.CallExpression, row: Row): string[] => {
  const names: string[] = [];
  for (
    let node: ts.Node | undefined = call;
    node !== undefined;
    node = node.parent
  ) {
    if (!ts.isCallExpression(node) || !closesInRow(node, row)) continue;
    const name = calleeName(node);
    if (name !== null) names.unshift(name);
  }
  return names;
};

/** Every distinct chain of three or more named calls in one file. A row
 * records each chain once, and a file holds one site per row. */
export const chainSitesOf = (file: string, content: string): ChainSite[] => {
  const rows = rowsOf(content);
  if (rows.length === 0) return [];
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const sites: ChainSite[] = [];
  for (const row of rows) {
    const seen = new Set<string>();
    for (const call of calls) {
      if (!closesInRow(call, row)) continue;
      const names = chainRound(call, row);
      const key = names.join("(");
      if (names.length < CHAIN_LENGTH || seen.has(key)) continue;
      seen.add(key);
      sites.push({
        file,
        line: lineColumnAt(content, row.start).line,
        names,
      });
    }
  }
  return sites;
};

/** The chain one run of names names, written `a(b(c(`. */
export const signatureOf = (names: readonly string[]): string =>
  joinStrings(map((name: string) => `${name}(`)(names));

/** Every chain of `CHAIN_LENGTH` adjacent methods inside one chain. */
export const runsOf = (names: readonly string[]): string[] =>
  names.flatMap((_, start) =>
    start + CHAIN_LENGTH > names.length
      ? []
      : [signatureOf(names.slice(start, start + CHAIN_LENGTH))],
  );

/** One chain name at each site that holds it, in reading order. */
const occurrencesOf = (
  sites: readonly ChainSite[],
): { signature: string; site: ChainSite }[] =>
  sites.flatMap((site) =>
    runsOf(site.names).map((signature) => ({ signature, site })),
  );

/** How many sites hold each chain that repeats at `REPEAT_LIMIT` sites or
 * more. A chain fewer sites hold is no duplication, so it counts nothing. */
export const countBySignature = (sites: readonly ChainSite[]): Counts => {
  const counts: Counts = {};
  for (const { signature } of occurrencesOf(sites)) {
    counts[signature] = (counts[signature] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count >= REPEAT_LIMIT),
  );
};

/** One finding, and where a reader meets it: a site, or the chain itself when
 * no site holds it any more. */
interface ChainFinding {
  fix: string;
  problem: string;
  rule: string;
  where: string;
}

/** Every site past its chain's recorded count, in reading order. */
const excessSiteFindings = (
  sites: readonly ChainSite[],
  counts: Counts,
  accepted: Counts,
): ChainFinding[] => {
  const seen = new Map<string, number>();
  const findings: ChainFinding[] = [];
  for (const { signature, site } of occurrencesOf(sites)) {
    const repeatCount = counts[signature];
    if (repeatCount === undefined) continue;
    const held = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, held);
    if (held <= (accepted[signature] ?? 0)) continue;
    findings.push({
      fix: FIX,
      problem: `${signature} repeats at ${repeatCount} sites`,
      rule: RULE,
      where: `${site.file}:${site.line}`,
    });
  }
  return findings;
};

/** Every recorded chain the tree no longer repeats as often, or no longer
 * repeats at all. */
const recordedStateFindings = (
  counts: Counts,
  accepted: Counts,
): ChainFinding[] =>
  Object.entries(accepted).flatMap(([signature, recorded]) => {
    const now = counts[signature] ?? 0;
    if (now >= recorded) return [];
    if (now === 0) {
      return [
        {
          fix: `delete the entry in ${REGISTRY}`,
          problem: `${signature} repeats no more`,
          rule: "stale-entry",
          where: signature,
        },
      ];
    }
    return [
      {
        fix: `run \`${UPDATE_COMMAND}\` to record the count`,
        problem: `${signature} repeats at ${now} sites, fewer than the recorded ${recorded}`,
        rule: "improved",
        where: signature,
      },
    ];
  });

/** One tree's chains against the recorded counts: a site past its chain's
 * count fails, a fallen count asks for its record, and a chain no site holds
 * any more asks for its entry's deletion. */
export const findIssues = (
  sites: readonly ChainSite[],
  accepted: Counts,
): ChainFinding[] => {
  const counts = countBySignature(sites);
  return [
    ...excessSiteFindings(sites, counts, accepted),
    ...recordedStateFindings(counts, accepted),
  ];
};
