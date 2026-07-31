/**
 * The holiday entity page: one owner-only Edit / Actions surface under
 * /admin/holidays/:id. Mutation handlers stay in holidays.ts.
 */

/* jscpd:ignore-start */
import {
  defineEditEntityPage,
  type EditEntityPage,
  submittedValueProps,
} from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { holidays } from "#shared/db/holidays.ts";
import type { Holiday } from "#shared/types.ts";
import { HolidayEditPanel } from "#templates/admin/holidays.tsx";

/* jscpd:ignore-end */

export const holidayPage: EditEntityPage<Holiday> = defineEditEntityPage({
  basePath: (id) => `/admin/holidays/${id}`,
  deleteLabelKey: "holidays.delete.submit",
  edit: (holiday, _ctx, rejected) =>
    Promise.resolve(
      HolidayEditPanel({ holiday, ...submittedValueProps(rejected) }),
    ),
  guard: requireOwnerOr,
  load: (id) => holidays.table.read.one({ id }),
  navActive: "/admin/holidays",
});
