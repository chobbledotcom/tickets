/**
 * Admin group management page templates
 */

import { joinStrings, map, pipe, sumOf } from "#fp";
import { t } from "#i18n";
import { groupReturnPath } from "#shared/admin-paths.ts";
import { resolveColumnLayout } from "#shared/column-order.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { toMajorUnits } from "#shared/currency.ts";
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
  hasTicketQuantity,
  type ListingWithCount,
} from "#shared/types.ts";
import { ListingRow, renderListingTable } from "#templates/admin/dashboard.tsx";
import {
  buildSharedDetailRows,
  renderDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
import {
  type ExpectedActualItem,
  ExpectedActualNotice,
  hasExpectedActualMismatches,
} from "#templates/admin/expected-actual.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { getGroupCreateFields, getGroupFields } from "#templates/fields.ts";
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
    <Layout title={t("terms.groups")}>
      <AdminNav active="/admin/groups" session={session} />
      <Flash success={successMessage} />
      {!isReadOnly() && (
        <p class="actions">
          <ActionButton href="/admin/groups/new" icon="plus">
            {t("groups.add_group")}
          </ActionButton>
        </p>
      )}
      {groups.length === 0 ? (
        <p>{t("groups.no_groups")}</p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("common.name")}</th>
                <th>{t("common.slug")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr>
                  <td>
                    {/* Staff open the detail page; editors can't (it decrypts
                        attendee PII), so they link straight to the edit form. */}
                    <a href={groupReturnPath(session.adminLevel, g.id)}>
                      {g.name}
                    </a>
                  </td>
                  <td>{g.slug}</td>
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
  entityToFieldValues(group, getGroupFields(), {
    hidden: (g) => booleanToCheckbox(g.hidden),
    hide_package_listings: (g) => booleanToCheckbox(g.hide_package_listings),
    is_package: (g) => booleanToCheckbox(g.is_package),
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
    <Layout title={t("groups.add.heading")}>
      <AdminNav active="/admin/groups" session={session} />
      <CsrfForm action="/admin/groups">
        <h1>{t("groups.add.heading")}</h1>
        <Flash error={error} />
        <Raw
          html={renderFields(getGroupCreateFields(), groupToFieldValues())}
        />
        <SubmitButton icon="plus">{t("groups.add.submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** A package member's saved per-unit price override (minor units; `null` = no
 * override, `0` = free) and fixed per-package quantity, keyed by listing id. */
export type PackageMemberValues = ReadonlyMap<
  number,
  { price: number | null; quantity: number }
>;

/**
 * Per-listing package overrides (per-unit price + quantity per package). Shown
 * only when "is a package" is ticked (the `.package-prices` block is hidden via
 * CSS while the checkbox is clear). A blank price means "no override — use the
 * listing's own price" (its base price is the placeholder); an explicit 0 means
 * the listing is free within the package. Quantity defaults to 1.
 */
const PackageMembersTable = ({
  listings,
  members,
}: {
  listings: ListingWithCount[];
  members: PackageMemberValues;
}): JSX.Element => (
  <div class="package-prices">
    <h2>{t("groups.package_prices.heading")}</h2>
    <p>{t("groups.package_prices.hint")}</p>
    {listings.length === 0 ? (
      <p>{t("groups.package_prices.no_listings")}</p>
    ) : (
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("fields.group.package_price")}</th>
              <th>{t("fields.group.package_quantity")}</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((e) => {
              const member = members.get(e.id);
              // null/absent → blank (no override); 0 → "0" (free); N → amount.
              const override = member?.price ?? null;
              return (
                <tr>
                  <td>{e.name}</td>
                  <td>
                    <input
                      inputmode="decimal"
                      name={`package_price_${e.id}`}
                      placeholder={toMajorUnits(e.unit_price)}
                      type="text"
                      value={override === null ? "" : toMajorUnits(override)}
                    />
                  </td>
                  <td>
                    <input
                      inputmode="numeric"
                      min="1"
                      name={`package_qty_${e.id}`}
                      type="number"
                      value={String(member?.quantity ?? 1)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

/**
 * Admin group edit page. Loads the group's listings and their current package
 * overrides (per-unit price + per-package quantity) so the members table can be
 * pre-filled.
 */
export const adminGroupEditPage = (
  group: Group,
  listings: ListingWithCount[],
  members: PackageMemberValues,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("groups.edit.heading")}>
      <AdminNav active="/admin/groups" session={session} />
      <CsrfForm action={`/admin/groups/${group.id}/edit`}>
        <h1>{t("groups.edit.heading")}</h1>
        <Flash error={error} />
        <Raw html={renderFields(getGroupFields(), groupToFieldValues(group))} />
        <PackageMembersTable listings={listings} members={members} />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
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
      <AdminNav active="/admin/groups" session={session} />
      <ConfirmForm
        action={`/admin/groups/${group.id}/delete`}
        buttonText={t("groups.delete.submit")}
        danger={false}
        label={t("groups.name_label")}
        name={group.name}
      >
        <h1>{t("groups.delete.heading")}</h1>
        <Flash error={error} />
        <p>
          {t("groups.delete.confirm", {
            name: `<strong>${group.name}</strong>`,
            slug: group.slug,
          })}
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

const totalAttendeeCount = sumOf((e: ListingWithCount) => e.attendee_count);
const totalTicketCount = sumOf((e: ListingWithCount) => e.tickets_count);
const totalIncome = sumOf((e: ListingWithCount) => e.income);

const groupAggregateMismatchItems = (
  listings: ListingWithCount[],
  attendees: Attendee[],
): ExpectedActualItem[] => {
  // tickets_count counts only real (quantity > 0) lines, so the expected side
  // must too — otherwise a group holding any no-quantity sentinel row would
  // report a bogus tickets_count drift. (booked_quantity/income sum quantity/
  // price_paid, to which a ghost contributes 0, so those sides stay unfiltered.)
  const realTicketCount = attendees.filter(hasTicketQuantity).length;
  // Quantity integrity only: the trigger-maintained booked_quantity/tickets_count
  // aggregates are cross-checked against the live attendee rows. Revenue is NOT
  // compared here — it is the ledger's job (projected income counts bookings
  // since deleted, which an attendee-sum can't), so a refund or a deletion would
  // make an income comparison flag a non-issue.
  const checks: Array<ExpectedActualItem & { matches: boolean }> = [
    {
      actual: String(totalAttendeeCount(listings)),
      expected: String(sumQuantity(attendees)),
      label: t("fields.listing.booked_quantity"),
      matches: totalAttendeeCount(listings) === sumQuantity(attendees),
    },
    {
      actual: String(totalTicketCount(listings)),
      expected: String(realTicketCount),
      label: t("fields.listing.tickets_count"),
      matches: totalTicketCount(listings) === realTicketCount,
    },
  ];
  return checks.filter((item) => !item.matches);
};

const GroupAggregateMismatchRow = ({
  attendees,
  listings,
}: {
  attendees: Attendee[];
  listings: ListingWithCount[];
}): JSX.Element | null => {
  const items = groupAggregateMismatchItems(listings, attendees);
  if (!hasExpectedActualMismatches(items)) return null;
  return (
    <tr>
      <th>{t("groups.running_total_check")}</th>
      <td>
        <ExpectedActualNotice
          actionHref="#listings"
          actionLabel={t("groups.running_totals_error_action")}
          explanation={t("groups.running_totals_error_explanation")}
          items={items}
          title={t("groups.running_totals_error_title")}
        />
      </td>
    </tr>
  );
};

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
        <th>{t("groups.group_attendees")}</th>
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
      <th>{t("groups.group_attendees")}</th>
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
/** The group's public-URL / QR / embed rows, or a "not bookable" note when its
 * `/ticket/<group>` route would 404 (a package with an incomplete or sold-out
 * bundle) — so the admin isn't handed dead share affordances. A non-package group
 * always renders (its page shows sold-out members rather than 404ing). */
const GroupShareRows = ({
  group,
  allowedDomain,
  ticketUrl,
  embedScriptCode,
  embedIframeCode,
  shareable,
}: {
  group: Group;
  allowedDomain: string;
  ticketUrl: string;
  embedScriptCode: string;
  embedIframeCode: string;
  shareable: boolean;
}): JSX.Element =>
  shareable ? (
    <>
      <tr>
        <th>{t("common.public_url")}</th>
        <td>
          <a href={ticketUrl}>{`${allowedDomain}/ticket/${group.slug}`}</a>
          <small>
            {" "}
            (<a href={`/ticket/${group.slug}/qr`}>{t("common.qr_code")}</a>)
          </small>
        </td>
      </tr>
      <tr>
        <th>
          <label for={`embed-script-${group.id}`}>
            {t("common.embed_script")}
          </label>
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
          <label for={`embed-iframe-${group.id}`}>
            {t("common.embed_iframe")}
          </label>
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
    </>
  ) : (
    <tr>
      <th>{t("common.public_url")}</th>
      <td>
        <em>{t("groups.detail.share_unavailable")}</em>
      </td>
    </tr>
  );

export const adminGroupDetailPage = (
  group: Group,
  listings: ListingWithCount[],
  ungroupedListings: ListingWithCount[],
  attendees: Attendee[],
  session: AdminSession,
  allowedDomain: string,
  hasPaidListing: boolean,
  shareable: boolean,
  phonePrefix?: string,
  successMessage?: string,
  questionData?: TableQuestionData,
  error?: string,
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
      : `<tr><td colspan="${columnKeys.length}">${t(
          "groups.detail.no_listings",
        )}</td></tr>`;

  const ticketUrl = `https://${allowedDomain}/ticket/${group.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const totalCount = totalAttendeeCount(listings);
  const tableRows = buildAttendeeRows(attendees, listings);
  const sharedRows = buildSharedDetailRows({
    attendeeCount: totalCount,
    attendees,
    hasPaidListing,
    maxCapacity: 0,
    // Revenue comes from the ledger (the listings' projected income), not a sum
    // over the loaded attendees: bookings since deleted still count, and a
    // package's override revenue is captured the same way.
    revenue: totalIncome(listings),
    ...(questionData !== undefined ? { questionData } : {}),
    skipAttendees: true,
  });

  return String(
    <Layout title={group.name}>
      <AdminNav active="/admin/groups" session={session} />
      <Flash error={error} success={successMessage} />
      <nav>
        <ul>
          {!isReadOnly() && (
            <>
              <li>
                <a href={`/admin/groups/${group.id}/edit`}>
                  {t("groups.detail.edit_group")}
                </a>
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
              {t("groups.detail.delete_group")}
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
              <GroupShareRows
                allowedDomain={allowedDomain}
                embedIframeCode={embedIframeCode}
                embedScriptCode={embedScriptCode}
                group={group}
                shareable={shareable}
                ticketUrl={ticketUrl}
              />
              {group.hidden && (
                <tr>
                  <th>{t("listings_table.hidden")}</th>
                  <td>Yes &mdash; not shown in public listings list</td>
                </tr>
              )}
              <GroupAttendeesRow attendeeCount={totalCount} group={group} />
              <GroupAggregateMismatchRow
                attendees={attendees}
                listings={listings}
              />
              <Raw html={renderDetailRows(sharedRows)} />
            </tbody>
          </table>
        </div>
      </article>

      <h2>{t("terms.listings")}</h2>
      <div class="table-scroll">
        <Raw html={renderListingTable(columnKeys, listingRows)} />
      </div>

      <article>
        <h2 id="attendees">{t("terms.attendees")}</h2>
        <div class="table-scroll">
          <Raw
            html={AttendeeTable({
              allowedDomain,
              ...(phonePrefix !== undefined ? { phonePrefix } : {}),
              ...(questionData !== undefined ? { questionData } : {}),
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
          <h2>{t("groups.detail.add_listings")}</h2>
          <CsrfForm action={`/admin/groups/${group.id}/add-listings`}>
            <fieldset class="checkboxes">
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
            <SubmitButton icon="plus">
              {t("groups.detail.add_listings_submit")}
            </SubmitButton>
          </CsrfForm>
        </>
      )}
    </Layout>,
  );
};
