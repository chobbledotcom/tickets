/**
 * Role-aware admin URL helpers.
 *
 * Several admin entities have a staff-only detail page (it decrypts attendee
 * PII) that editors can't open. Wherever we link to or redirect toward such an
 * entity, editors must instead be sent to its edit form. These helpers encode
 * that single rule so it isn't re-derived at each call site.
 */

import type { AdminLevel } from "#shared/types.ts";

/** Where a content role should be sent for an entity that has a staff-only
 * detail page: editors go to the edit form, everyone else to the detail page.
 * `base` is the entity's route prefix, e.g. `/admin/listing` or `/admin/groups`. */
const entityReturnPath = (
  adminLevel: AdminLevel,
  base: string,
  id: number,
): string => (adminLevel === "editor" ? `${base}/${id}/edit` : `${base}/${id}`);

/** Role-aware return path for a listing (detail for staff, edit for editors). */
export const listingReturnPath = (adminLevel: AdminLevel, id: number): string =>
  entityReturnPath(adminLevel, "/admin/listing", id);

/** Role-aware return path for a group (detail for staff, edit for editors). */
export const groupReturnPath = (adminLevel: AdminLevel, id: number): string =>
  entityReturnPath(adminLevel, "/admin/groups", id);
