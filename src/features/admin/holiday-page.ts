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
import { adminPattern } from "#shared/admin-surface.ts";
import { holidays } from "#shared/db/holidays.ts";
import type { Holiday } from "#shared/types.ts";
import { HolidayEditPanel } from "#templates/admin/holidays.tsx";

/* jscpd:ignore-end */

export const holidayPage: EditEntityPage<Holiday> = defineEditEntityPage({
  deleteLabelKey: "holidays.delete.submit",
  destination: "holiday",
  edit: (holiday, _ctx, rejected) =>
    Promise.resolve(
      HolidayEditPanel({ holiday, ...submittedValueProps(rejected) }),
    ),
  load: (id) => holidays.table.read.one({ id }),
  navActive: adminPattern("holidays"),
});
