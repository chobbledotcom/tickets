import { schemaMigration } from "./define.ts";

/** Matches the old {{listing}} column tag (with optional inner whitespace and
 * an optional trailing filter) without touching the new {{listings}} tag —
 * the required non-word delimiter after "listing" can't be an "s". */
const LISTING_TAG = /\{\{(\s*)listing(\s*[|}])/g;

/**
 * The attendee table's per-booking "Listing" column became the grouped
 * "Listings" column, renaming its column-order template tag from {{listing}}
 * to {{listings}}. Rewrite the tag inside any stored attendee_column_order
 * setting so an operator's custom column order keeps its listings column
 * (an unknown tag would otherwise make the whole template fall back to the
 * default order). Data-only — no schema requirement — and a no-op when the
 * setting is unset or never used the tag.
 */
export default schemaMigration(
  "2026-07-03_attendee_listings_tag",
  "Rename the {{listing}} tag to {{listings}} in the stored attendee column-order template.",
  {},
  async ({ getDb }) => {
    const result = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'attendee_column_order'",
    );
    const value = result.rows[0]?.value;
    if (typeof value !== "string") return;
    const updated = value.replace(LISTING_TAG, "{{$1listings$2");
    if (updated === value) return;
    await getDb().execute(
      "UPDATE settings SET value = ? WHERE key = 'attendee_column_order'",
      [updated],
    );
  },
);
