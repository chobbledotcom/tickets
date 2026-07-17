/**
 * The holiday entity page: one owner-only Edit / Actions surface under
 * /admin/holidays/:id. Mutation handlers stay in holidays.ts.
 */

/* jscpd:ignore-start */
import {
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
} from "#routes/admin/entity-pages.ts";
import { writeFormTab } from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { holidays } from "#shared/db/holidays.ts";
import type { Holiday } from "#shared/types.ts";
import { HolidayEditPanel } from "#templates/admin/holidays.tsx";

/* jscpd:ignore-end */

const actionsTab = deleteActionTab<Holiday>(
  "holidays.delete.submit",
  (holiday) => `/admin/holidays/${holiday.id}/delete`,
);

export const holidayPage: EntityPage<Holiday> = defineEntityPage({
  basePath: (id) => `/admin/holidays/${id}`,
  guard: requireOwnerOr,
  load: (id) => holidays.table.findById(id),
  navActive: "/admin/holidays",
  tabs: [
    writeFormTab("edit", "entity.tab.edit", (holiday) =>
      Promise.resolve(HolidayEditPanel({ holiday })),
    ),
    actionsTab,
  ],
  titleOf: (holiday) => holiday.name,
});
