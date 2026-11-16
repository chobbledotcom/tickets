/**
 * The built-site record: its table, its one write rule, and its write
 * commands. Every site field is encrypted into one blob, so the record writes
 * through the built-site module rather than a row statement.
 */

import type { BuiltSite, BuiltSiteFormInput } from "#db/built-sites/types.ts";
import {
  builtSites,
  createBuiltSite,
  deleteBuiltSite,
  findBuiltSiteById,
  findBuiltSiteByIdPrimary,
  updateBuiltSite,
} from "#db/built-sites.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import {
  answerWrite,
  logNameActivity,
  type RecordShapeOf,
  type WriteVerdict,
} from "#shared/rest/record.ts";
import { deleteCommand } from "#shared/rest/record-command.ts";

/** The one built-site rule: the form and the table own the boundary checks,
 * so any string that reached this point is written as it arrived. */
const logBuiltSite = logNameActivity("Built site");

/** Write the built-site row and its activity line, mapping a validation
 *  failure to the refusal the handler answers. */
const commitBuiltSite = (
  verb: "created" | "updated",
  write: () => Promise<BuiltSite | null>,
): Promise<WriteVerdict<BuiltSite>> =>
  answerWrite(write, (row) => logBuiltSite(row.name, verb));

/** Save one built site and its activity line. A built site has no domain
 * rule. */
const saveBuiltSite = (
  id: number | null,
  input: BuiltSiteFormInput,
  verb: "created" | "updated",
): Promise<WriteVerdict<BuiltSite>> =>
  commitBuiltSite(verb, () =>
    id === null ? createBuiltSite(input) : updateBuiltSite(id, () => input),
  );

const builtSiteWrites = {
  create: (input: BuiltSiteFormInput) => saveBuiltSite(null, input, "created"),
  remove: deleteCommand(
    findBuiltSiteById,
    (site) => deleteBuiltSite(site.id),
    (site) => logBuiltSite(site.name, "deleted"),
  ),
  update: (id: number, input: BuiltSiteFormInput) =>
    saveBuiltSite(id, input, "updated"),
} as const;

export const builtSiteRecord = defineNamedRowRecord<
  RecordShapeOf<BuiltSite, BuiltSiteFormInput>
>()({
  activityName: "Built site",
  getAll: builtSites.getAll,
  load: findBuiltSiteById,
  loadAfterWrite: findBuiltSiteByIdPrimary,
  nameLabel: "built_sites.name_label",
  surface: "builtSites",
  write: builtSiteWrites,
});
