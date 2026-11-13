/**
 * The built-site record: its table, its one write rule, and its write
 * commands. Every site field is encrypted into one blob, so the table adapter
 * writes through its insert/update/delete façade rather than a row statement.
 */

import type { BuiltSite, BuiltSiteFormInput } from "#db/built-sites/types.ts";
import { builtSites, builtSitesCrudTable } from "#db/built-sites.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import {
  answerWrite,
  logNameActivity,
  type RecordShapeOf,
  type WriteVerdict,
} from "#shared/rest/record.ts";
import { deleteCommand } from "#shared/rest/record-command.ts";
import { okResult, type Result } from "#shared/result.ts";

/** The one built-site rule: the form and the table own the boundary checks,
 * so any string that reached this point is written as it arrived. */
const builtSiteRule = (input: BuiltSiteFormInput): Result<BuiltSiteFormInput> =>
  okResult(input);

const logBuiltSite = logNameActivity("Built site");

/** Write the built-site row and its activity line, mapping a validation
 *  failure to the refusal the handler answers. */
const commitBuiltSite = (
  verb: "created" | "updated",
  write: () => Promise<BuiltSite | null>,
): Promise<WriteVerdict<BuiltSite>> =>
  answerWrite(write, (row) => logBuiltSite(row.name, verb));

/** Save one built site and its activity line. The rule admits every input, so
 * there is no refusal to answer here. */
const saveBuiltSite = (
  id: number | null,
  input: BuiltSiteFormInput,
  verb: "created" | "updated",
): Promise<WriteVerdict<BuiltSite>> =>
  commitBuiltSite(verb, () =>
    id === null
      ? builtSitesCrudTable.insert(input)
      : builtSitesCrudTable.update(id, input),
  );

const builtSiteWrites = {
  create: (input: BuiltSiteFormInput) => saveBuiltSite(null, input, "created"),
  remove: deleteCommand(
    (siteId) => builtSitesCrudTable.read.one({ id: siteId }),
    (site) => builtSitesCrudTable.deleteById(site.id),
    (site) => logBuiltSite(site.name, "deleted"),
  ),
  update: (id: number, input: BuiltSiteFormInput) =>
    saveBuiltSite(id, input, "updated"),
} as const;

export const builtSiteRecord = defineNamedRowRecord<
  RecordShapeOf<BuiltSite, BuiltSiteFormInput>
>({
  activityName: "Built site",
  getAll: builtSites.getAll,
  nameLabel: "built_sites.name_label",
  rule: builtSiteRule,
  surface: "builtSites",
  table: builtSitesCrudTable,
  write: builtSiteWrites,
});
