/**
 * Admin group management page templates
 */

import { map, pipe, sumOf } from "#fp";
import { t } from "#i18n";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
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
  CsrfForm,
  entityToFieldValues,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type AdminSession,
  type Attendee,
  availableDayCounts,
  dayPriceFor,
  type Group,
  hasTicketQuantity,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  errorAdminPage,
  successAdminPage,
} from "#templates/admin/admin-page.tsx";
import {
  AttendeeTableBlock,
  attendeeTableOptions,
} from "#templates/admin/attendee-table-block.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { CopyableInputRow } from "#templates/admin/copyable-row.tsx";
import {
  renderListingRows,
  renderListingTable,
} from "#templates/admin/dashboard.tsx";
import {
  buildSharedDetailRows,
  renderDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
import {
  type ExpectedActualItem,
  ExpectedActualTableRow,
} from "#templates/admin/expected-actual.tsx";
import {
  PublicTicketLink,
  UnavailablePublicUrlRow,
} from "#templates/admin/share-rows.tsx";
import type {
  AttendeeTableRow,
  TableQuestionData,
} from "#templates/attendee-table.tsx";
import {
  GuideFooter,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { GroupCapacityMeter } from "#templates/components/capacity.tsx";
import { DataTable, textColumns } from "#templates/components/data-table.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import {
  getGroupCreateFields,
  getGroupFields,
} from "#templates/fields/group.ts";

/**
 * Admin groups list page
 */
export const adminGroupsPage = (
  groups: Group[],
  session: AdminSession,
  successMessage?: string,
): string =>
  successAdminPage(t("terms.groups"), "/admin/groups")(session, successMessage)(
    <>
      {groups.length === 0 ? (
        <p>{t("groups.no_groups")}</p>
      ) : (
        // Staff open the detail page; editors can't (it decrypts attendee PII),
        // so they link straight to the edit form.
        <DataTable
          columns={[{ header: t("common.name") }, { header: t("common.slug") }]}
          rows={groups.map((g) => [
            <a
              href={entityReturnPath("/admin/groups", session.adminLevel, g.id)}
            >
              {g.name}
            </a>,
            g.slug,
          ])}
        />
      )}

      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#packages">
        {t("groups.guide_link")}
      </GuideFooter>
    </>,
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
  errorAdminPage(t("groups.add.heading"), "/admin/groups/new")(session, error)(
    <NewResourceForm
      action="/admin/groups"
      fieldsHtml={renderFields(getGroupCreateFields(), groupToFieldValues())}
      submitLabel={t("groups.add.submit")}
      title={t("groups.add.heading")}
    />,
  );

/** A package member's saved per-unit price override (minor units; `null` = no
 * override, `0` = free), fixed per-package quantity, and any per-day overrides
 * (day count → minor units) for a customisable member, keyed by listing id. */
export type PackageMemberValues = ReadonlyMap<
  number,
  {
    price: number | null;
    quantity: number;
    dayPrices?: ReadonlyMap<number, number>;
  }
>;

/** Per-day override inputs for one customisable member — one input per day
 * count the listing itself offers (an override can reprice a span, never invent
 * one). The listing's own entered day price is the placeholder; a blank input
 * charges it, an explicit 0 makes that span free in this package. */
const MemberDayPriceInputs = ({
  listing,
  dayPrices,
}: {
  listing: ListingWithCount;
  dayPrices: ReadonlyMap<number, number> | undefined;
}): JSX.Element => (
  <div class="package-day-prices">
    {availableDayCounts(listing).map((days) => {
      const override = dayPrices?.get(days);
      return (
        <label>
          {t("fields.group.package_day_price", { count: days })}
          <input
            inputmode="decimal"
            name={`package_day_price_${listing.id}_${days}`}
            // Every count from availableDayCounts has a configured day price.
            placeholder={toMajorUnits(dayPriceFor(listing, days)!)}
            type="text"
            value={override === undefined ? "" : toMajorUnits(override)}
          />
        </label>
      );
    })}
  </div>
);

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
      <DataTable
        columns={textColumns(
          "common.name",
          "fields.group.package_price",
          "fields.group.package_quantity",
        )}
        rows={listings.map((e) => {
          const member = members.get(e.id);
          // null/absent → blank (no override); 0 → "0" (free); N → amount.
          const override = member?.price ?? null;
          return [
            e.name,
            <>
              <input
                inputmode="decimal"
                name={`package_price_${e.id}`}
                placeholder={toMajorUnits(e.unit_price)}
                type="text"
                value={override === null ? "" : toMajorUnits(override)}
              />
              {e.customisable_days && (
                <MemberDayPriceInputs
                  dayPrices={member?.dayPrices}
                  listing={e}
                />
              )}
            </>,
            <input
              inputmode="numeric"
              min="1"
              name={`package_qty_${e.id}`}
              type="number"
              value={String(member?.quantity ?? 1)}
            />,
          ];
        })}
      />
    )}
  </div>
);

/**
 * The Edit tab of the group entity page: the group form plus the per-listing
 * package-price table, pre-filled from the group's current overrides (per-unit
 * price + per-package quantity). Session-free and error-free — a rejected save
 * re-renders the same tab with the flash error surfaced by the Layout backstop.
 */
export const GroupEditPanel = ({
  group,
  listings,
  members,
}: {
  group: Group;
  listings: ListingWithCount[];
  members: PackageMemberValues;
}): JSX.Element => (
  <>
    <CsrfForm action={`/admin/groups/${group.id}/edit`}>
      <Raw html={renderFields(getGroupFields(), groupToFieldValues(group))} />
      <PackageMembersTable listings={listings} members={members} />
      {SaveChangesButton()}
    </CsrfForm>
  </>
);

/**
 * Admin group delete confirmation page
 */
export const adminGroupDeletePage = (
  group: Group,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/groups/${group.id}/delete`,
    active: { section: "/admin/groups" },
    buttonText: t("groups.delete.submit"),
    children: (
      <>
        <h1>{t("groups.delete.heading")}</h1>
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
      </>
    ),
    danger: false,
    error,
    label: t("groups.name_label"),
    name: group.name,
    session,
    title: t("groups.delete.heading"),
  });

/** Build one AttendeeTableRow per booking line, looking up each line's listing.
 * Stays per-line (not grouped by attendee) so every line keeps its own
 * check-in button. */
const buildAttendeeRows = (
  attendees: Attendee[],
  listings: ListingWithCount[],
): AttendeeTableRow[] => {
  const listingMap = new Map(
    map((e: ListingWithCount) => [e.id, e] as const)(listings),
  );
  return pipe(
    map(
      (a: Attendee): AttendeeTableRow =>
        attendeeLineRow(a, listingMap.get(a.listing_id)!),
    ),
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
  return ExpectedActualTableRow({
    header: t("groups.running_total_check"),
    notice: {
      actionHref: "#listings",
      actionLabel: t("groups.running_totals_error_action"),
      explanation: t("groups.running_totals_error_explanation"),
      items,
      title: t("groups.running_totals_error_title"),
    },
  });
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
  return (
    <tr>
      <th>{t("groups.group_attendees")}</th>
      <td>
        <GroupCapacityMeter count={attendeeCount} max={group.max_attendees} />{" "}
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
          <PublicTicketLink
            href={ticketUrl}
            label={`${allowedDomain}/ticket/${group.slug}`}
            qrHref={`/ticket/${group.slug}/qr`}
          />
        </td>
      </tr>
      {CopyableInputRow({
        id: `embed-script-${group.id}`,
        label: t("common.embed_script"),
        value: embedScriptCode,
      })}
      {CopyableInputRow({
        id: `embed-iframe-${group.id}`,
        label: t("common.embed_iframe"),
        value: embedIframeCode,
      })}
    </>
  ) : (
    <UnavailablePublicUrlRow message={t("groups.detail.share_unavailable")} />
  );

/**
 * The Overview tab of the group entity page: the group's detail table (share /
 * QR / embed rows, hidden status, capacity, aggregate-integrity check, shared
 * totals), the member-listings table, and the add-listings membership form.
 * Staff-only and session-free — the entity page renders the title + flash.
 */
export const GroupOverviewPanel = ({
  group,
  listings,
  ungroupedListings,
  attendees,
  allowedDomain,
  hasPaidListing,
  shareable,
  questionData,
}: {
  group: Group;
  listings: ListingWithCount[];
  ungroupedListings: ListingWithCount[];
  attendees: Attendee[];
  allowedDomain: string;
  hasPaidListing: boolean;
  shareable: boolean;
  questionData?: TableQuestionData;
}): JSX.Element => {
  const { columnKeys, filters } = resolveColumnLayout(
    settings.listingColumnOrder,
    Object.keys(LISTING_TABLE_COLUMNS),
    LISTING_DEFAULT_ORDER,
  );
  const listingRows = renderListingRows({
    columnKeys,
    emptyText: t("groups.detail.no_listings"),
    filters,
    listings,
  });

  const ticketUrl = `https://${allowedDomain}/ticket/${group.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const totalCount = totalAttendeeCount(listings);
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

  return (
    <>
      <article>
        <DetailTable>
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
        </DetailTable>
      </article>

      <h2>{t("terms.listings")}</h2>
      <div class="table-scroll">
        <Raw html={renderListingTable(columnKeys, listingRows)} />
      </div>

      {!isReadOnly() && ungroupedListings.length > 0 && (
        <CsrfForm action={`/admin/groups/${group.id}/add-listings`}>
          <LinkedItemsCheckboxes
            groups={[
              {
                label: t("terms.listings"),
                options: toLinkedItemOptions(ungroupedListings, []),
              },
            ]}
            heading={({ type }) => t("linked_items.heading_add", { type })}
            name="listing_ids"
          />
          <SubmitButton icon="plus">
            {t("groups.detail.add_listings_submit")}
          </SubmitButton>
        </CsrfForm>
      )}
    </>
  );
};

/**
 * The Attendees tab of the group entity page: one attendee row per booking line
 * across every listing in the group, each keeping its own check-in action.
 * Staff-only and session-free.
 */
export const GroupAttendeesPanel = ({
  group,
  listings,
  attendees,
  allowedDomain,
  phonePrefix,
  questionData,
}: {
  group: Group;
  listings: ListingWithCount[];
  attendees: Attendee[];
  allowedDomain: string;
  phonePrefix?: string;
  questionData?: TableQuestionData;
}): JSX.Element => (
  <article>
    <h2 id="attendees">{t("terms.attendees")}</h2>
    <AttendeeTableBlock
      options={attendeeTableOptions({
        allowedDomain,
        phonePrefix,
        questionData,
        returnUrl: `/admin/groups/${group.id}/attendees`,
        rows: buildAttendeeRows(attendees, listings),
        showDate: listings.some((e) => e.listing_type === "daily"),
        showListing: true,
      })}
    />
  </article>
);
