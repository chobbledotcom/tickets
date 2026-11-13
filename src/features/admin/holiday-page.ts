/**
 * The holiday entity page: one owner-only Edit / Actions surface under
 * /admin/holidays/:id. Mutation handlers stay in holidays.ts.
 */

import type { Holiday } from "#db/holidays.ts";
import {
  type EditEntityPage,
  submittedValueProps,
} from "#routes/admin/entity-write-tab.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { HolidayEditPanel } from "#templates/admin/holidays.tsx";

import { recordEditPage } from "./record-edit-page.ts";

export const holidayPage: EditEntityPage<Holiday> = recordEditPage(
  holidayRecord,
  {
    deleteLabelKey: "holidays.delete.submit",
    edit: (holiday, _ctx, rejected) =>
      Promise.resolve(
        HolidayEditPanel({ holiday, ...submittedValueProps(rejected) }),
      ),
  },
);
