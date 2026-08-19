/**
 * The holiday entity page: one owner-only Edit / Actions surface under
 * /admin/holidays/:id. Mutation handlers stay in holidays.ts.
 */

import { holidays } from "#db/holidays.ts";
/* jscpd:ignore-start */
import {
  defineEditEntityPage,
  type EditEntityPage,
  submittedValueProps,
} from "#routes/admin/entity-write-tab.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { HolidayEditPanel } from "#templates/admin/holidays.tsx";
import type { Holiday } from "#types";

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
