/**
 * The built-site record: its table, its one write rule, and its write
 * commands. Every site field is encrypted into one blob, so the table adapter
 * writes through its insert/update/delete façade rather than a row statement.
 */

import { logActivity } from "#db/activity-log.ts";
import type { BuiltSite, BuiltSiteFormInput } from "#db/built-sites/types.ts";
import { builtSites, builtSitesCrudTable } from "#db/built-sites.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { DeleteVerdict, WriteVerdict } from "#shared/rest/record.ts";
import { updateIfPresent } from "#shared/rest/record-command.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
import { okResult, type Result } from "#shared/result.ts";

/** The one built-site rule: the form and the table own the boundary checks,
 * so any string that reached this point is written as it arrived. */
const builtSiteRule = (input: BuiltSiteFormInput): Result<BuiltSiteFormInput> =>
  okResult(input);

const logBuiltSite = (name: string, verb: string): Promise<unknown> =>
  logActivity(`Built site '${name}' ${verb}`);

/** Write the built-site row and its activity line, mapping a validation
 *  failure to the refusal the handler answers. */
const commitBuiltSite = async (
  verb: "created" | "updated",
  write: () => Promise<BuiltSite | null>,
): Promise<WriteVerdict<BuiltSite>> => {
  try {
    const row = await write();
    if (row === null) return { kind: "not-found" };
    await logBuiltSite(row.name, verb);
    return { kind: "written", row };
  } catch (error) {
    return {
      kind: "refused",
      message: transactionValidationMessageOrRethrow(error),
    };
  }
};

/** Save one built site and its activity line. The rule runs first. */
const saveBuiltSite = (
  id: number | null,
  input: BuiltSiteFormInput,
  verb: "created" | "updated",
): Promise<WriteVerdict<BuiltSite>> => {
  const ruled = builtSiteRule(input);
  if (!ruled.ok)
    return Promise.resolve({ kind: "refused", message: ruled.error });
  return commitBuiltSite(verb, () =>
    id === null
      ? builtSitesCrudTable.insert(ruled.value)
      : builtSitesCrudTable.update(id, ruled.value),
  );
};

const builtSiteWrites = {
  create: (input: BuiltSiteFormInput) => saveBuiltSite(null, input, "created"),
  remove: async (id: number): Promise<DeleteVerdict> => {
    const site = await builtSitesCrudTable.read.one({ id });
    if (site === null) return { kind: "not-found" };
    await builtSitesCrudTable.deleteById(id);
    await logBuiltSite(site.name, "deleted");
    return { kind: "deleted" };
  },
  update: (id: number, input: BuiltSiteFormInput) =>
    updateIfPresent(
      id,
      (siteId) => builtSitesCrudTable.read.exists({ id: siteId }),
      () => saveBuiltSite(id, input, "updated"),
    ),
} as const;

export const builtSiteRecord = defineNamedRowRecord<
  BuiltSite,
  BuiltSiteFormInput
>({
  activityName: "Built site",
  deleteDestination: "builtSiteDelete",
  getAll: builtSites.getAll,
  list: "builtSites",
  rule: builtSiteRule,
  table: builtSitesCrudTable,
  write: builtSiteWrites,
});
