import { sumOf } from "#fp";
import { t } from "#i18n";
import type { ListingMoneyTotals } from "#shared/accounting/listing-money-totals.ts";
import type { GroupListingCandidate } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import { buildEmbedSnippets } from "#shared/embed.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  type Attendee,
  type Group,
  hasTicketQuantity,
  type ListingWithCount,
} from "#shared/types.ts";
import { CopyableInputRow } from "#templates/admin/copyable-row.tsx";
import {
  buildSharedDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
import {
  type ExpectedActualItem,
  ExpectedActualTableRow,
} from "#templates/admin/expected-actual.tsx";
import { HiddenDetailRow } from "#templates/admin/hidden-row.tsx";
import { renderListingsTableSection } from "#templates/admin/listing-table.tsx";
import { MoneySummaryBlock } from "#templates/admin/listings/ledger-section.tsx";
import {
  PublicTicketLink,
  UnavailablePublicUrlRow,
} from "#templates/admin/share-rows.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import { GroupCapacityMeter } from "#templates/components/capacity.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import {
  PageBlock,
  PageRegions,
} from "#templates/components/page-structure.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

const totalAttendeeCount = sumOf(
  (listing: ListingWithCount) => listing.attendee_count,
);
const totalTicketCount = sumOf(
  (listing: ListingWithCount) => listing.tickets_count,
);

const groupAggregateMismatchItems = (
  listings: ListingWithCount[],
  attendees: Attendee[],
): ExpectedActualItem[] => {
  // tickets_count excludes no-quantity sentinel rows, so the check must too.
  const realTicketCount = attendees.filter(hasTicketQuantity).length;
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
}): JSX.Element | null =>
  ExpectedActualTableRow({
    header: t("groups.running_total_check"),
    notice: {
      actionHref: "#listings",
      actionLabel: t("groups.running_totals_error_action"),
      explanation: t("groups.running_totals_error_explanation"),
      items: groupAggregateMismatchItems(listings, attendees),
      title: t("groups.running_totals_error_title"),
    },
  });

const GroupAttendeesRow = ({
  group,
  attendeeCount,
}: {
  group: Group;
  attendeeCount: number;
}): JSX.Element => (
  <LabelledRow label={t("groups.group_attendees")}>
    {group.max_attendees <= 0 ? (
      <>
        {attendeeCount} <small>({t("groups.detail.no_group_cap")})</small>
      </>
    ) : (
      <>
        <GroupCapacityMeter count={attendeeCount} max={group.max_attendees} />{" "}
        <small>{t("groups.detail.attendees_scope")}</small>
      </>
    )}
  </LabelledRow>
);

/** Public share rows, or a note when the public group route would not work. */
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
      <LabelledRow label={t("common.public_url")}>
        <PublicTicketLink
          href={ticketUrl}
          label={`${allowedDomain}/ticket/${group.slug}`}
          qrHref={`/ticket/${group.slug}/qr`}
        />
      </LabelledRow>
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

/** The Overview tab's details, money summary, listings, and membership form. */
export const GroupOverviewPanel = ({
  group,
  listings,
  ungroupedListings,
  attendees,
  allowedDomain,
  hasPaidListing,
  ledgerHref,
  money,
  shareable,
  questionData,
}: {
  group: Group;
  listings: ListingWithCount[];
  ungroupedListings: GroupListingCandidate[];
  attendees: Attendee[];
  allowedDomain: string;
  hasPaidListing: boolean;
  ledgerHref?: string | undefined;
  money: ListingMoneyTotals;
  shareable: boolean;
  questionData?: TableQuestionData;
}): JSX.Element => {
  const { columnKeys, filters } = settings.listingColumnLayout;
  const ticketUrl = `https://${allowedDomain}/ticket/${group.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const totalCount = totalAttendeeCount(listings);
  const net = money.netBalance - money.servicingCosts;
  const showMoney = hasPaidListing || money.transferCount > 0;
  const sharedRows = buildSharedDetailRows({
    attendeeCount: totalCount,
    attendees,
    hasPaidListing: false,
    maxCapacity: 0,
    // The ledger includes deleted bookings and package override revenue.
    revenue: money.recognisedIncome,
    ...(questionData !== undefined ? { questionData } : {}),
    skipAttendees: true,
  });

  return (
    <PageRegions>
      <article>
        <DetailTable rows={sharedRows}>
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
          {group.hidden && <HiddenDetailRow />}
          <GroupAttendeesRow attendeeCount={totalCount} group={group} />
          <GroupAggregateMismatchRow
            attendees={attendees}
            listings={listings}
          />
        </DetailTable>
      </article>

      {showMoney && (
        <MoneySummaryBlock
          ledgerHref={ledgerHref}
          ledgerLabel={t("groups.money.view_ledger")}
          note={t("groups.money.note")}
          rows={[
            {
              amount: money.recognisedIncome,
              label: t("groups.money.income"),
            },
            {
              amount: -money.servicingCosts,
              label: t("groups.money.costs"),
            },
            {
              amount: -money.refunds,
              label: t("groups.money.refunds"),
            },
            {
              amount: -money.externalCosts,
              label: t("groups.money.external_costs"),
            },
            {
              amount: net,
              label: t("groups.money.net"),
              signed: false,
              subtotal: true,
            },
          ]}
          title={t("groups.money.heading")}
        />
      )}

      <PageBlock>
        <h2>{t("terms.listings")}</h2>
        {renderListingsTableSection({
          columnKeys,
          emptyText: t("groups.detail.no_listings"),
          filters,
          listings,
        })}
      </PageBlock>

      {!isReadOnly() && ungroupedListings.length > 0 && (
        <SaveForm
          action={`/admin/groups/${group.id}/add-listings`}
          submitIcon="plus"
          submitLabel={t("groups.detail.add_listings_submit")}
        >
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
        </SaveForm>
      )}
    </PageRegions>
  );
};
