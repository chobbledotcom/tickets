/**
 * Admin group management page templates
 */

import { map, pipe, reduce } from "#fp";
import { t } from "#i18n";
import { buildEmbedSnippets } from "#lib/embed.ts";
import {
  CsrfForm,
  renderError,
  renderFields,
  renderSuccess,
} from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import {
  type AdminSession,
  type Attendee,
  type EventWithCount,
  type Group,
  isPaidEvent,
} from "#lib/types.ts";
import { EventRow } from "#templates/admin/dashboard.tsx";
import {
  buildSharedDetailRows,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import { groupCreateFields, groupFields } from "#templates/fields.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/**
 * Admin groups list page
 */
export const adminGroupsPage = (
  groups: Group[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title={t("groups.heading")}>
      <AdminNav session={session} active="/admin/groups" />
      <h1>{t("groups.heading")}</h1>
      <Raw html={renderSuccess(successMessage)} />
      <p>
        <a href="/admin/group/new">{t("groups.add_group")}</a>
      </p>
      {groups.length === 0 ? (
        <p>{t("groups.no_groups")}</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("groups.col.name")}</th>
                <th>{t("groups.col.slug")}</th>
                <th>{t("groups.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr>
                  <td>
                    <a href={`/admin/group/${g.id}`}>{g.name}</a>
                  </td>
                  <td>{g.slug}</td>
                  <td>
                    <a href={`/admin/group/${g.id}/edit`}>{t("groups.edit")}</a>{" "}
                    <a href={`/admin/group/${g.id}/delete`}>{t("groups.delete")}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>,
  );

/**
 * Group create/edit form values
 */
export const groupToFieldValues = (
  group?: Group,
): Record<string, string | number | null> => {
  const name = group?.name ?? "";
  const slug = group?.slug ?? "";
  const terms = group?.terms_and_conditions ?? "";
  const max_attendees = group?.max_attendees || null;
  return { name, slug, terms_and_conditions: terms, max_attendees };
};

/**
 * Admin group create page
 */
export const adminGroupNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("groups.add.heading")}>
      <AdminNav session={session} active="/admin/groups" />
      <h1>{t("groups.add.heading")}</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action="/admin/group">
        <Raw html={renderFields(groupCreateFields, groupToFieldValues())} />
        <button type="submit">{t("groups.add.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin group edit page
 */
export const adminGroupEditPage = (
  group: Group,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("groups.edit.heading")}>
      <AdminNav session={session} active="/admin/groups" />
      <h1>{t("groups.edit.heading")}</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action={`/admin/group/${group.id}/edit`}>
        <Raw html={renderFields(groupFields, groupToFieldValues(group))} />
        <button type="submit">{t("groups.edit.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin group delete confirmation page
 */
export const adminGroupDeletePage = (
  group: Group,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("groups.delete.heading")}>
      <AdminNav session={session} active="/admin/groups" />
      <h1>{t("groups.delete.heading")}</h1>
      <Raw html={renderError(error)} />
      <p>
        <Raw
          html={t("groups.delete.confirm", {
            name: `<strong>${escapeHtml(group.name)}</strong>`,
            slug: escapeHtml(group.slug),
          })}
        />
      </p>
      <p>{t("groups.delete.events_note")}</p>
      <p>{t("groups.delete.confirm_prompt")}</p>
      <CsrfForm action={`/admin/group/${group.id}/delete`}>
        <label>
          {t("groups.delete.confirm_label")}
          <input type="text" name="confirm_identifier" required />
        </label>
        <button type="submit">{t("groups.delete.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/** Build AttendeeTableRows from attendees with event lookup */
const buildAttendeeRows = (
  attendees: Attendee[],
  events: EventWithCount[],
): AttendeeTableRow[] => {
  const eventMap = new Map(
    map((e: EventWithCount) => [e.id, e] as const)(events),
  );
  return pipe(
    map((a: Attendee): AttendeeTableRow => {
      const event = eventMap.get(a.event_id)!;
      return {
        attendee: a,
        eventId: event.id,
        eventName: event.name,
      };
    }),
  )(attendees);
};

/** Sum attendee_count across all events in the group */
const totalAttendeeCount = reduce(
  (sum: number, e: EventWithCount) => sum + e.attendee_count,
  0,
);

/** Sum max_attendees across all events in the group */
const totalMaxAttendees = reduce(
  (sum: number, e: EventWithCount) => sum + e.max_attendees,
  0,
);

/**
 * Admin group detail page - shows group info, events in group, and add-events form
 */
export const adminGroupDetailPage = (
  group: Group,
  events: EventWithCount[],
  ungroupedEvents: EventWithCount[],
  attendees: Attendee[],
  session: AdminSession,
  allowedDomain: string,
  phonePrefix?: string,
  successMessage?: string,
  questionData?: TableQuestionData,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(
          map((e: EventWithCount) => EventRow({ e })),
          joinStrings,
        )(events)
      : `<tr><td colspan="5">${escapeHtml(t("groups.detail.no_events"))}</td></tr>`;

  const ticketUrl = `https://${allowedDomain}/ticket/${group.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const hasPaidEvent = events.some(isPaidEvent);
  const totalCount = totalAttendeeCount(events);
  const tableRows = buildAttendeeRows(attendees, events);
  const effectiveCapacity =
    group.max_attendees > 0
      ? group.max_attendees
      : totalMaxAttendees(events);
  const sharedRows = buildSharedDetailRows({
    attendees,
    attendeeCount: totalCount,
    maxCapacity: effectiveCapacity,
    hasPaidEvent,
    questionData,
  });

  return String(
    <Layout title={group.name} mainClass="stack-xl">
      <AdminNav session={session} active="/admin/groups" />
      <h1>{group.name}</h1>
      <Raw html={renderSuccess(successMessage)} />
      {group.terms_and_conditions && (
        <p>{t("groups.detail.terms_label")} {group.terms_and_conditions}</p>
      )}
      <p>
        <a href={`/admin/group/${group.id}/edit`}>{t("groups.detail.edit_group")}</a>{" "}
        <a href={`/admin/group/${group.id}/delete`}>{t("groups.detail.delete_group")}</a>
      </p>

      <article>
        <h2>{t("groups.detail.group_details")}</h2>
        <div class="table-scroll">
          <table class="event-details-table">
            <tbody>
              <tr>
                <th>{t("groups.detail.public_url")}</th>
                <td>
                  <a
                    href={ticketUrl}
                  >{`${allowedDomain}/ticket/${group.slug}`}</a>
                  <small>
                    {" "}
                    (<a href={`/ticket/${group.slug}/qr`}>{t("groups.detail.qr_code")}</a>)
                  </small>
                </td>
              </tr>
              <tr>
                <th>
                  <label for={`embed-script-${group.id}`}>{t("groups.detail.embed_script")}</label>
                </th>
                <td>
                  <input
                    type="text"
                    id={`embed-script-${group.id}`}
                    value={embedScriptCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
              <tr>
                <th>
                  <label for={`embed-iframe-${group.id}`}>{t("groups.detail.embed_iframe")}</label>
                </th>
                <td>
                  <input
                    type="text"
                    id={`embed-iframe-${group.id}`}
                    value={embedIframeCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
              <Raw html={renderDetailRows(sharedRows)} />
            </tbody>
          </table>
        </div>
      </article>

      <h2>{t("groups.detail.events_heading")}</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Attendees</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={eventRows} />
          </tbody>
        </table>
      </div>

      <article>
        <h2 id="attendees">Attendees</h2>
        <div class="table-scroll">
          <Raw
            html={AttendeeTable({
              rows: tableRows,
              allowedDomain,
              showEvent: true,
              showDate: events.some((e) => e.event_type === "daily"),
              returnUrl: `/admin/group/${group.id}#attendees`,
              phonePrefix,
              questionData,
            })}
          />
        </div>
      </article>

      {ungroupedEvents.length > 0 && (
        <>
          <h2>Add Events to Group</h2>
          <CsrfForm action={`/admin/group/${group.id}/add-events`}>
            {ungroupedEvents.map((e) => (
              <label>
                <input type="checkbox" name="event_ids" value={String(e.id)} />
                {` ${e.name}`}
              </label>
            ))}
            <br />
            <button type="submit">Add Selected Events</button>
          </CsrfForm>
        </>
      )}
    </Layout>,
  );
};
