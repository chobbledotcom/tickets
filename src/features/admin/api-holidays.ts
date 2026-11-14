/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 * The audience and the write rule come from the holiday record. The body
 * reads come from the holiday fields.
 */

import type { Holiday, HolidayInput } from "#db/holidays.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { bodyMappers } from "#shared/rest/field-reads.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";

export const holidayApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.holidays,
  RecordShapeOf<Holiday, HolidayInput>
>(holidayRecord, bodyMappers(HOLIDAY_FIELDS));
