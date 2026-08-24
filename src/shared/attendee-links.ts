import { isServicing } from "#db/attendees/kind.ts";

export type AttendeeLinkTarget = {
  id: number;
  kind: string | null | undefined;
};

/** Admin detail path for an attendee-like row. */
export const attendeeAdminPath = ({ id, kind }: AttendeeLinkTarget): string =>
  isServicing(kind) ? `/admin/servicing/${id}` : `/admin/attendees/${id}`;
