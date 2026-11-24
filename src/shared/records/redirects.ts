/**
 * The redirect record: its table, its one write rule, and its admin surface.
 * An operator adds and deletes redirects. None is edited, so the record
 * declares no update.
 */

import { records } from "#db/record-table.ts";
import {
  createRedirect,
  deleteRedirect,
  type Redirect,
  type RedirectConflict,
  type RedirectInput,
  redirects,
} from "#db/redirects.ts";
import { tables } from "#db/select/tables.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import {
  checkRedirectFrom,
  checkRedirectTo,
  redirectKeyOfTarget,
} from "#shared/redirect-paths.ts";
import {
  defineRecord,
  logNameActivity,
  type RecordShapeOf,
} from "#shared/rest/record.ts";
import { commitCommand, deleteCommand } from "#shared/rest/record-command.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The one redirect rule. It keeps the key of the missing page and the new
 *  address. It refuses an unsafe address and a redirect to its own page. Both
 *  doors answer the same refusal. The message of each refusal is the catalog
 *  key that ends with its code. */
export const redirectRule = (input: RedirectInput): Result<RedirectInput> => {
  if (
    input.fromPath.length > MAX_INPUT_LENGTH ||
    input.toUrl.length > MAX_INPUT_LENGTH
  ) {
    return errorResult(
      t("redirects.error.too_long", { max: MAX_INPUT_LENGTH }),
    );
  }
  const fromPath = checkRedirectFrom(input.fromPath);
  if (!fromPath.ok) {
    return errorResult(t(`redirects.error.from_${fromPath.error}`));
  }
  const toUrl = checkRedirectTo(input.toUrl);
  if (!toUrl.ok) return errorResult(t(`redirects.error.to_${toUrl.error}`));
  return redirectKeyOfTarget(toUrl.value) === fromPath.value
    ? errorResult(t("redirects.error.same_page"))
    : okResult({ fromPath: fromPath.value, toUrl: toUrl.value });
};

const logRedirect = logNameActivity("Redirect");

/** The name of a redirect is the page that it leaves. */
const fromPathOf = ({ fromPath }: { fromPath: string }): string => fromPath;

export const redirectRecord = defineRecord<
  RecordShapeOf<Redirect, RedirectInput>
>()({
  activityName: "Redirect",
  api: ADMIN_API_RESOURCES.redirects,
  getAll: redirects.getAll,
  logName: fromPathOf,
  nameField: "fromPath",
  nameLabel: "redirects.name_label",
  nameOf: fromPathOf,
  rule: redirectRule,
  surface: { deleteDestination: "redirectDelete", list: "redirects" },
  table: tables.redirects,
  write: {
    create: (input) =>
      commitCommand<Redirect, RedirectInput, RedirectConflict>({
        input,
        log: (row) => logRedirect(fromPathOf(row), "created"),
        message: (conflict) => t(`redirects.error.${conflict}`),
        rule: redirectRule,
        stored: null,
        write: createRedirect,
      }),
    remove: deleteCommand(
      records.redirects.find,
      (row) => deleteRedirect(row.id),
      (row) => logRedirect(fromPathOf(row), "deleted"),
    ),
  },
});
