/**
 * Admin group management page templates
 */

import { joinStrings, map, pipe, reduce } from "#fp";
import { resolveColumnLayout } from "#shared/column-order.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { settings } from "#shared/db/settings.ts";
import { buildEmbedSnippets } from "#shared/embed.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  booleanToCheckbox,
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type AdminSession,
  type Attendee,
  type Group,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import { ListingRow, renderListingTable } from "#templates/admin/dashboard.tsx";
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
import { Layout } from "#templates/layout.tsx";

/**
 * Admin groups list page
 */
export const adminGroupsPage = (
  groups: Group[],
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <Layout title="Groups">
      <AdminNav active="/admin/groups" session={session} />
      <Flash success={successMessage} />
      {!isReadOnly() && (
        <p>
          <a href="/admin/groups/new">Add Group</a>
        </p>
      )}
      {groups.length === 0 ? (
        <p>No groups configured.</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr>
                  <td>
                    <a href={`/admin/groups/${g.id}`}>{g.name}</a>
                  </td>
                  <td>{g.slug}</td>
                  <td>
                    {!isReadOnly() && (
                      <>
                        <a href={`/admin/groups/${g.id}/edit`}>Edit</a>{" "}
                      </>
                    )}
                    <a href={`/admin/groups/${g.id}/delete`}>Delete</a>
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
): Record<string, string | number | null> =>
  entityToFieldValues(group, groupFields, {
    hidden: (g) => booleanToCheckbox(g.hidden),
    max_attendees: (g) => g.max_attendees || null,
  });

/**
 * Admin group create page
 */
export const adminGroupNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Add Group">
      <AdminNav active="/admin/groups" session={session} />
      <CsrfForm action="/admin/groups">
        <h1>Add Group</h1>
        <Flash error={error} />
        <Raw html={renderFields(groupCreateFields, groupToFieldValues())} />
        <button type="submit">Create Group</button>
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
    <Layout title="Edit Group">
      <AdminNav active="/admin/groups" session={session} />
      <CsrfForm action={`/admin/groups/${group.id}/edit`}>
        <h1>Edit Group</h1>
        <Flash error={error} />
        <Raw html={renderFields(groupFields, groupToFieldValues(group))} />
        <button type="submit">Save Changes</button>
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
    <Layout title="Delete Group">
      <AdminNav active="/admin/groups" session={session} />
      <ConfirmForm
        action={`/admin/groups/${group.id}/delete`}
        buttonText="Delete Group"
        danger={false}
        label="Group name"
        name={group.name}
      >
        <h1>Delete Group</h1>
        <Flash error={error} />
        <p>
          Are you sure you want to delete the group{" "}
          <strong>{group.name}</strong> ({group.slug})?
        </p>
        <p>
          Listings in this group will not be deleted -- they will be moved out
          of the group.
        </p>
        <p>Type the group name "{group.name}" to confirm:</p>
      </ConfirmForm>
    </Layout>,
  );

/** Build AttendeeTableRows from attendees with listing lookup */
const buildAttendeeRows = (
  attendees: Attendee[],
  listings: ListingWithCount[],
): AttendeeTableRow[] => {
  const listingMap = new Map(
    map((e: ListingWithCount) => [e.id, e] as const)(listings),
  );
  return pipe(
    map((a: Attendee): AttendeeTableRow => {
      const listing = listingMap.get(a.listing_id)!;
      return {
        attendee: a,
        listingId: listing.id,
        listingName: listing.name,
      };
    }),
  )(attendees);
};

const totalAttendeeCount = reduce(
  (sum: number, e: ListingWithCount) => sum + e.attendee_count,
  0,
);

/** Render the group-attendees row. The cap fragment is omitted when the
 * group is uncapped so the displayed total isn't conflated with a fake
 * limit. */
const GroupAttendeesRow = ({
  group,
  attendeeCount,
}: {
  group: Group;
  attendeeCount: number;
}): JSX.Element => {
  if (group.max_attendees <= 0) {
    return (
      <tr>
        <th>Group Attendees</th>
        <td>
          {attendeeCount} <small>(no group cap)</small>
        </td>
      </tr>
    );
  }
  const remaining = Math.max(0, group.max_attendees - attendeeCount);
  const overCap = attendeeCount >= group.max_attendees;
  const nearCap = attendeeCount >= group.max_attendees * 0.9;
  return (
    <tr>
      <th>Group Attendees</th>
      <td>
        <span class={overCap || nearCap ? "danger-text" : ""}>
          {attendeeCount} / {group.max_attendees} &mdash; {remaining} remain
        </span>{" "}
        <small>across all listings in the group</small>
      </td>
    </tr>
  );
};

/**
 * Admin group detail page - shows group info, listings in group, and add-listings form
 */
export const adminGroupDetailPage = (
  group: Group,
  listings: ListingWithCount[],
  ungroupedListings: ListingWithCount[],
  attendees: Attendee[],
  session: AdminSession,
  allowedDomain: string,
  phonePrefix?: string,
  successMessage?: string,
  questionData?: TableQuestionData,
): string => {
  const { columnKeys, filters } = resolveColumnLayout(
    settings.listingColumnOrder,
    Object.keys(LISTING_TABLE_COLUMNS),
    LISTING_DEFAULT_ORDER,
  );
  const listingRows =
    listings.length > 0
      ? pipe(
          map((e: ListingWithCount) => ListingRow({ columnKeys, e, filters })),
          joinStrings,
        )(listings)
      : `<tr><td colspan="${columnKeys.length}">No listings in this group</td></tr>`;

  const ticketUrl = `https://${allowedDomain}/ticket/${group.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const hasPaidListing = listings.some(isPaidListing);
  const totalCount = totalAttendeeCount(listings);
  const tableRows = buildAttendeeRows(attendees, listings);
  const sharedRows = buildSharedDetailRows({
    attendeeCount: totalCount,
    attendees,
    hasPaidListing,
    maxCapacity: 0,
    questionData,
    skipAttendees: true,
  });

  return String(
    <Layout title={group.name}>
      <AdminNav active="/admin/groups" session={session} />
      <Flash success={successMessage} />
      <nav>
        <ul>
          {!isReadOnly() && (
            <>
              <li>
                <a href={`/admin/groups/${group.id}/edit`}>Edit Group</a>
              </li>
              <li>
                <a href={`/admin/groups/${group.id}/bulk-actions`}>
                  Bulk Actions
                </a>
              </li>
            </>
          )}
          <li>
            <a class="danger" href={`/admin/groups/${group.id}/delete`}>
              Delete Group
            </a>
          </li>
        </ul>
      </nav>

      <article>
        <div class="table-scroll">
          <table class="listing-details-table">
            <tbody>
              <tr>
                <th colspan="2">{group.name}</th>
              </tr>
              <tr>
                <th>Public URL</th>
                <td>
                  <a href={ticketUrl}>
                    {`${allowedDomain}/ticket/${group.slug}`}
                  </a>
                  <small>
                    {" "}
                    (<a href={`/ticket/${group.slug}/qr`}>QR Code</a>)
                  </small>
                </td>
              </tr>
              <tr>
                <th>
                  <label for={`embed-script-${group.id}`}>Embed Script</label>
                </th>
                <td>
                  <input
                    data-select-on-click
                    id={`embed-script-${group.id}`}
                    readonly
                    type="text"
                    value={embedScriptCode}
                  />
                </td>
              </tr>
              <tr>
                <th>
                  <label for={`embed-iframe-${group.id}`}>Embed Iframe</label>
                </th>
                <td>
                  <input
                    data-select-on-click
                    id={`embed-iframe-${group.id}`}
                    readonly
                    type="text"
                    value={embedIframeCode}
                  />
                </td>
              </tr>
              {group.hidden && (
                <tr>
                  <th>Hidden</th>
                  <td>Yes &mdash; not shown in public listings list</td>
                </tr>
              )}
              <GroupAttendeesRow attendeeCount={totalCount} group={group} />
              <Raw html={renderDetailRows(sharedRows)} />
            </tbody>
          </table>
        </div>
      </article>

      <h2>Listings</h2>
      <div class="table-scroll">
        <Raw html={renderListingTable(columnKeys, listingRows)} />
      </div>

      <article>
        <h2 id="attendees">Attendees</h2>
        <div class="table-scroll">
          <Raw
            html={AttendeeTable({
              allowedDomain,
              phonePrefix,
              questionData,
              returnUrl: `/admin/groups/${group.id}#attendees`,
              rows: tableRows,
              showDate: listings.some((e) => e.listing_type === "daily"),
              showListing: true,
            })}
          />
        </div>
      </article>

      {!isReadOnly() && ungroupedListings.length > 0 && (
        <>
          <h2>Add Listings to Group</h2>
          <CsrfForm action={`/admin/groups/${group.id}/add-listings`}>
            <fieldset class="checkbox-group">
              {ungroupedListings.map((e) => (
                <label>
                  <input
                    name="listing_ids"
                    type="checkbox"
                    value={String(e.id)}
                  />
                  {` ${e.name}`}
                </label>
              ))}
            </fieldset>
            <button type="submit">Add Selected Listings</button>
          </CsrfForm>
        </>
      )}
    </Layout>,
  );
};
