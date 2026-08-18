/**
 * Admin attendees browser page — a paginated, filterable table of attendee
 * bookings across every listing. Deliberately minimal: the notes summary plus
 * the shared filtered attendee table, which works out the controls to offer
 * from the page's {@link AttendeeListSetup}.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type {
  AttendeeListSetup,
  AttendeeListState,
  AttendeeSort,
} from "#shared/attendee-list-controls.ts";
import type { SystemNote } from "#shared/db/notes/types.ts";
import {
  type AdminSession,
  type AttendeeTableRow,
  isOwnerRole,
} from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { AttendeeNotesSummary } from "#templates/admin/attendee-notes.tsx";
import { FilteredAttendeeTable } from "#templates/attendee-table/controls.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";

/* jscpd:ignore-end */

const NAV_ACTIVE = "/admin/attendees";

export type AttendeesListPageProps = {
  session: AdminSession;
  rows: AttendeeTableRow[];
  /** The page's controls: every listing, the type filter, sort, and paging. */
  setup: AttendeeListSetup<AttendeeSort>;
  /** The visitor's current filter and sort choices. */
  state: AttendeeListState<AttendeeSort>;
  /** Whether a further page of results exists */
  hasNext: boolean;
  allowedDomain: string;
  phonePrefix: string;
  /** Decrypted notes for the listed attendees (empty when none). */
  systemNotes: SystemNote[];
  /** Attendee id → display name, for labelling notes in the summary. */
  names: Map<number, string>;
};

/** Admin attendees browser page */
export const adminAttendeesListPage = (props: AttendeesListPageProps): string =>
  String(
    <AdminPage
      active={NAV_ACTIVE}
      session={props.session}
      title={t("terms.attendees")}
    >
      <PageBlock>
        <AttendeeNotesSummary
          isOwner={isOwnerRole(props.session.adminLevel)}
          names={props.names}
          notes={props.systemNotes}
        />

        <FilteredAttendeeTable
          hasNext={props.hasNext}
          options={{
            allowedDomain: props.allowedDomain,
            emptyMessage: t("attendees_list.no_attendees_yet"),
            phonePrefix: props.phonePrefix,
            presorted: true,
            rows: props.rows,
            showCheckin: false,
            showDate: false,
            showListing: true,
          }}
          view={{ setup: props.setup, state: props.state }}
        />
      </PageBlock>

      <GuideFooter href="/admin/guide#attendees">
        {t("attendees_list.guide_link")}
      </GuideFooter>
    </AdminPage>,
  );
