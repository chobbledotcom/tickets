/**
 * The group and listing note features. Notes are owner-key encrypted, so the
 * staff floor (owner + manager) is who can read and write them — the same
 * audience the attendee notes declare.
 *
 * The shared record-notes factory supplies the four routes and the page
 * banner wiring. This module only says how each kind loads and names its
 * records.
 */

import { getGroupById } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import type { Group, ListingWithCount } from "#types";
import { recordNoteFeature } from "./record-notes.ts";

/** The group's note routes and its page banner wiring. */
export const groupNoteFeature = recordNoteFeature({
  activeSection: adminPattern("groups"),
  entityKind: "group",
  loadRecord: (id: number) => getGroupById(id),
  nameOf: (group: Group) => group.name,
  noteBasePath: (id: number) => `/admin/groups/${id}/note`,
  notePattern: "/admin/groups/:id/note",
  recordPagePath: (id: number) => `/admin/groups/${id}`,
});

/** The listing's note routes and its page banner wiring. */
export const listingNoteFeature = recordNoteFeature({
  activeSection: adminPattern("listings"),
  entityKind: "listing",
  loadRecord: (id: number) => getListingWithCount(id),
  nameOf: (listing: ListingWithCount) => listing.name,
  noteBasePath: (id: number) => `/admin/listing/${id}/note`,
  notePattern: "/admin/listing/:id/note",
  recordPagePath: (id: number) => `/admin/listing/${id}`,
});
