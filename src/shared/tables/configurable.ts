/** Pure configurable-table schemas. UI modules attach cell renderers to these. */

import * as v from "valibot";
import { defineTableLayout } from "#shared/tables/layout.ts";

const AttendeeColumnKeySchema = v.picklist([
  "status",
  "date",
  "name",
  "listings",
  "email",
  "phone",
  "address",
  "special_instructions",
  "answers",
  "qty",
  "ticket",
  "registered",
]);

export type AttendeeColumnKey = v.InferOutput<typeof AttendeeColumnKeySchema>;

const attendee = defineTableLayout(
  AttendeeColumnKeySchema,
  AttendeeColumnKeySchema.options,
);

const LISTING_DEFAULT_COLUMN_KEYS = [
  "name",
  "description",
  "status",
  "attendees",
  "tickets",
  "revenue",
  "cost",
  "profit",
  "created",
] as const;

const ListingColumnKeySchema = v.picklist([
  ...LISTING_DEFAULT_COLUMN_KEYS,
  "date",
  "location",
  "price",
  "renewal",
]);

export type ListingColumnKey = v.InferOutput<typeof ListingColumnKeySchema>;

const listing = defineTableLayout(
  ListingColumnKeySchema,
  LISTING_DEFAULT_COLUMN_KEYS,
);

export const configurableTableLayouts = { attendee, listing } as const;
