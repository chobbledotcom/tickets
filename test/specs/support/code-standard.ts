/**
 * The code-quality job's own boundary: the two detectors the job runs over
 * every source file, driven here against isolated fixture text and against
 * the site's real tree. A finding is the job's failure, and it carries the
 * file and the line to fix.
 */

// jscpd:ignore-start
import { ALLOWED_REPEATED_BINDS } from "#test/integration/code-quality/allowlists.ts";
import {
  findHandNumberedSql,
  findNumberedBindViolations,
  findRepeatedBinds,
} from "#test/scripts/code-quality/numbered-binds.ts";
import {
  ensureLoaded,
  getRelativePath,
} from "#test/scripts/code-quality/scan-context.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The one synthetic file the fixtures live in. */
const FIXTURE_FILE = "shared/db/synthetic.ts";

/** A statement that binds the same value twice — the shape the numbered
 * builder exists to replace. */
const REPEATED_BIND = `const statement = {
  args: [listingId, PRICE_TYPE_BASE, listingId],
  sql: "DELETE FROM listing_prices WHERE listing_id = ? AND price_type = ? AND EXISTS (SELECT 1 FROM listings WHERE id = ?)",
};`;

/** A statement built the way the standard asks: one bind per value, the
 * builder reusing the token. */
const BUILT_STATEMENT = `const statement = numberedStatement((bind) =>
  \`DELETE FROM listing_prices WHERE listing_id = \${bind(listingId)} AND price_type = \${bind(priceType)}\`,
);`;

/** SQL text that spells a numbered parameter itself. */
const HAND_NUMBERED = `const sql = "DELETE FROM t WHERE parent_id = ?1 OR child_id = ?1";`;

/** The clause assembly the code-standard allows to bind its parts twice, and
 * a neighbour in the same file that binds one value twice with no allowance. */
const ALLOWED_ASSEMBLY = `const accountsScope = (accounts: AccountRef[]): WhereClause => {
  const part = { args: [type, ...ids, type, ...ids], clause };
  return { args: part.args, clause };
};`;

const NEIGHBOURING_ASSEMBLY =
  "const transfersFor = { args: [id, id], sql: transferSql };";

const ALLOWED_ENTRY = ["shared/accounting/queries.ts:accountsScope"];

/** What the job reported last, ready for the Then that reads it. */
const report = (world: TicketsWorld, findings: string[]): void => {
  world.codeStandardFindings = findings;
};

/** The job reads a statement that binds one value twice. */
export const readsARepeatedBind = (world: TicketsWorld): void => {
  report(world, findRepeatedBinds(FIXTURE_FILE, REPEATED_BIND, []));
};

/** The job reads a statement built through the numbered builder. */
export const readsABuiltStatement = (world: TicketsWorld): void => {
  report(world, [
    ...findRepeatedBinds(FIXTURE_FILE, BUILT_STATEMENT, []),
    ...findHandNumberedSql(FIXTURE_FILE, BUILT_STATEMENT),
  ]);
};

/** The job reads SQL text that spells a numbered parameter itself. */
export const readsAHandNumberedToken = (world: TicketsWorld): void => {
  report(world, findHandNumberedSql(FIXTURE_FILE, HAND_NUMBERED));
};

/** What the job says about one file's text at the allowed assembly's path,
 * with the one allowance the code-standard grants. */
const reportBinds = (world: TicketsWorld, content: string): void => {
  report(
    world,
    findRepeatedBinds("shared/accounting/queries.ts", content, ALLOWED_ENTRY),
  );
};

/** The job reads the allowed clause assembly, bound twice inside its own
 * declaration. */
export const readsTheAllowedAssembly = (world: TicketsWorld): void => {
  reportBinds(world, ALLOWED_ASSEMBLY);
};

/** The job reads the same file again, with a neighbouring assembly that
 * binds one value twice outside the allowed declaration. */
export const readsTheNeighbouringAssembly = (world: TicketsWorld): void => {
  reportBinds(world, `${ALLOWED_ASSEMBLY}\n${NEIGHBOURING_ASSEMBLY}`);
};

/** The job reads every source file the site has, the way the guard runs it:
 * each detector over the real tree, with the real allowances. */
export const readsEverySourceFile = async (
  world: TicketsWorld,
): Promise<void> => {
  const { srcFiles, srcContents } = await ensureLoaded();
  report(
    world,
    findNumberedBindViolations(
      srcFiles,
      srcContents,
      getRelativePath,
      ALLOWED_REPEATED_BINDS,
    ),
  );
};
