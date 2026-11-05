import { isServicing } from "#db/attendees/kind.ts";

export type AttendeeLinkTarget = {
  id: number;
  kind: string | null | undefined;
};

/** The bounded lookups that a link back to an attendee or a service event
 *  needs. One holds the decrypted name to show. The other holds the kind that
 *  picks the detail page. Both come from the same row, so an id in one is in
 *  the other unless the row was deleted between the two reads. */
export type AttendeeLinkRefs = {
  kinds: Map<number, string>;
  names: Map<number, string>;
};

/** Admin detail path for an attendee-like row. */
export const attendeeAdminPath = ({ id, kind }: AttendeeLinkTarget): string =>
  isServicing(kind) ? `/admin/servicing/${id}` : `/admin/attendees/${id}`;
