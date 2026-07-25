/* jscpd:ignore-start */
import { fieldById, filter, identity, map, mapById } from "#fp";
import { t } from "#i18n";
import type { AuthSession } from "#routes/auth.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import type {
  ServicingCostRecord,
  ServicingEvent,
  ServicingEventSummary,
} from "#shared/db/attendees/servicing.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { type Field, requireChoiceOptions } from "#shared/forms/field.ts";
import { renderFields } from "#shared/forms/rendering.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { isOwnerRole, type ListingWithCount } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import {
  ServicingEventEditLink,
  servicingEventDateLabel,
} from "#templates/admin/servicing-events.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import { buildServicingFieldSchema } from "./form-model.ts";

/* jscpd:ignore-end */

const SERVICING_FORM_ID = "servicing-form";

export type ServicingPrefill = {
  quantities: Map<number, number>;
  startDate: string;
};

const emptyServicingPrefill = (): ServicingPrefill => ({
  quantities: new Map(),
  startDate: "",
});

export const activeServicingListings = (
  listings: ListingWithCount[],
): ListingWithCount[] =>
  filter((listing: ListingWithCount) => listing.active)(listings);

/** Keep inactive listings while an event still holds them, and report holds
 * whose listing row has been deleted. */
export const listingsForServicingEdit = (
  allListings: ListingWithCount[],
  event: ServicingEvent,
): { deletedHolds: number[]; listings: ListingWithCount[] } => {
  const listingById = mapById(identity<ListingWithCount>)(allListings);
  const heldIds = new Set(
    map((booking: ServicingEvent["bookings"][number]) => booking.listingId)(
      event.bookings,
    ),
  );
  const inactiveHolds = filter(
    (listing: ListingWithCount) => !listing.active && heldIds.has(listing.id),
  )(allListings);
  return {
    deletedHolds: filter((id: number) => !listingById.has(id))([...heldIds]),
    listings: [...activeServicingListings(allListings), ...inactiveHolds],
  };
};

const firstBookingDate = (
  event: ServicingEvent | null,
  prefill: ServicingPrefill,
): string =>
  event?.bookings.find((booking) => booking.date)?.date ?? prefill.startDate;

const firstBookingDuration = (event: ServicingEvent | null): number =>
  event?.bookings.find((booking) => booking.durationDays)?.durationDays ?? 1;

const listingFormQuantities = (
  listings: ListingWithCount[],
  event: ServicingEvent | null,
  quantities: Map<number, number>,
): Map<number, number> =>
  new Map([
    ...map((listing: ListingWithCount) => [listing.id, 0] as const)(listings),
    ...quantities,
    ...map(
      (booking: ServicingEvent["bookings"][number]) =>
        [booking.listingId, booking.quantity!] as const,
    )(event?.bookings ?? []),
  ]);

const servicingListingsTable = defineTable<
  ListingWithCount,
  ReadonlyMap<number, number>
>([
  translatedTableColumn<ListingWithCount, ReadonlyMap<number, number>>(
    "listing",
    "servicing.column.listing",
    (listing) => (
      <>
        {listing.name}
        {listing.active ? "" : <em> {t("servicing.inactive")}</em>}
      </>
    ),
  ),
  translatedTableColumn<ListingWithCount, ReadonlyMap<number, number>>(
    "quantity",
    "servicing.column.quantity",
    (listing, quantities) => (
      <input
        min="0"
        name={`quantity_${listing.id}`}
        type="number"
        value={String(quantities.get(listing.id)!)}
      />
    ),
  ),
]);

const costFields = (listings: ListingWithCount[]): Field[] => [
  {
    label: t("servicing.field.note"),
    name: "memo",
    type: "text",
  },
  {
    label: t("servicing.field.listing"),
    name: "target_listing_id",
    options: requireChoiceOptions(
      t("servicing.field.listing"),
      map((listing: ListingWithCount) => ({
        label: listing.name,
        value: String(listing.id),
      }))(listings),
    ),
    type: "select",
  },
];

type ServicingCostTableContext = {
  eventId: number;
  listingNames: ReadonlyMap<number, string>;
  session: AuthSession;
};

const costListingDisplay = (
  cost: ServicingCostRecord,
  context: ServicingCostTableContext,
): { ledgerHref: string | null; name: string } => {
  const listingName = context.listingNames.get(cost.listingId);
  return {
    ledgerHref:
      isOwnerRole(context.session.adminLevel) && listingName !== undefined
        ? listingLedgerHref(cost.listingId)
        : null,
    name: listingName ?? t("servicing.deleted_listing"),
  };
};

const servicingCostsTable = defineTable<
  ServicingCostRecord,
  ServicingCostTableContext
>([
  translatedTableColumn<ServicingCostRecord, ServicingCostTableContext>(
    "listing",
    "servicing.column.listing",
    (cost, context) => {
      const listing = costListingDisplay(cost, context);
      return listing.ledgerHref === null ? (
        listing.name
      ) : (
        <a href={listing.ledgerHref}>{listing.name}</a>
      );
    },
  ),
  translatedTableColumn<ServicingCostRecord, ServicingCostTableContext>(
    "date",
    "servicing.column.date",
    (cost) => formatDateLabel(cost.date.slice(0, 10)),
  ),
  {
    ...translatedTableColumn<ServicingCostRecord, ServicingCostTableContext>(
      "amount",
      "servicing.column.amount",
      (cost) => formatCurrency(cost.amount),
    ),
    class: "amount",
  },
  translatedTableColumn<ServicingCostRecord, ServicingCostTableContext>(
    "note",
    "servicing.column.note",
    (cost) => cost.memo,
  ),
  translatedTableColumn<ServicingCostRecord, ServicingCostTableContext>(
    "actions",
    "servicing.column.actions",
    (cost, context) => {
      const { ledgerHref } = costListingDisplay(cost, context);
      return (
        <>
          <CsrfForm
            action={`/admin/servicing/${context.eventId}/cost/${cost.id}`}
          >
            <PriceInput name="amount" value={toMajorUnits(cost.amount)} />
            <SubmitButton icon="save">
              {t("servicing.action.edit")}
            </SubmitButton>
          </CsrfForm>
          {ledgerHref !== null && (
            <a href={ledgerHref}>{t("servicing.action.view_money_history")}</a>
          )}
        </>
      );
    },
  ),
]);

const servicingEventsTable = defineTable<
  ServicingEventSummary,
  ReadonlyMap<number, string>
>([
  translatedTableColumn<ServicingEventSummary, ReadonlyMap<number, string>>(
    "name",
    "servicing.column.name",
    (event) => <ServicingEventEditLink event={event} />,
  ),
  translatedTableColumn<ServicingEventSummary, ReadonlyMap<number, string>>(
    "date",
    "servicing.column.date",
    (event) => servicingEventDateLabel(event.date),
  ),
  translatedTableColumn<ServicingEventSummary, ReadonlyMap<number, string>>(
    "listings",
    "servicing.column.listings",
    (event, listingNames) =>
      map(
        (booking: { listingId: number }) =>
          listingNames.get(booking.listingId) ?? t("servicing.deleted_listing"),
      )(event.bookings).join(", "),
  ),
  translatedTableColumn<ServicingEventSummary, ReadonlyMap<number, string>>(
    "quantity",
    "servicing.column.quantity",
    (event) => event.totalQuantity,
  ),
]);

export const renderServicingPage = ({
  costListingNames = new Map(),
  costs = [],
  deletedHolds = [],
  event,
  listings,
  prefill = emptyServicingPrefill(),
  session,
}: {
  costListingNames?: Map<number, string>;
  costs?: ServicingCostRecord[];
  deletedHolds?: number[];
  event: ServicingEvent | null;
  listings: ListingWithCount[];
  prefill?: ServicingPrefill;
  session: AuthSession;
}): string => {
  const title = event?.name ?? t("servicing.new_title");
  const action = event
    ? `/admin/servicing/${event.id}`
    : "/admin/servicing/new";
  return String(
    <AdminPage
      active={event ? { section: "/admin/servicing" } : "/admin/servicing/new"}
      session={session}
      title={title}
    >
      <h1>{title}</h1>
      {deletedHolds.length > 0 && (
        <p class="warning">
          {t("servicing.deleted_holds_warning", { count: deletedHolds.length })}
        </p>
      )}
      <CsrfForm action={action} id={SERVICING_FORM_ID}>
        <Raw
          html={renderFields(buildServicingFieldSchema(), {
            day_count: firstBookingDuration(event),
            name: event?.name ?? "",
            start_date: firstBookingDate(event, prefill),
          })}
        />
        {renderTable(servicingListingsTable, listings, {
          context: listingFormQuantities(listings, event, prefill.quantities),
        })}
        <SubmitButton icon={event ? "save" : "plus"}>
          {t(
            event
              ? "servicing.action.save_event"
              : "servicing.action.create_event",
          )}
        </SubmitButton>
      </CsrfForm>
      {event && (
        <>
          <SaveForm
            action={`/admin/servicing/${event.id}/duplicate`}
            submitIcon="rotate-ccw"
            submitLabel={t("servicing.action.duplicate")}
          />
          <SaveForm
            action={`/admin/servicing/${event.id}/delete`}
            submitClass="danger"
            submitIcon="trash-2"
            submitLabel={t("servicing.action.delete_event")}
          />
          {listings.length > 0 && (
            <CsrfForm action={`/admin/servicing/${event.id}`}>
              <SectionFieldset
                className="listing-section"
                legend={t("servicing.money_out")}
              >
                <p>{t("servicing.money_out_intro")}</p>
                <input
                  name="cost_idempotency_key"
                  type="hidden"
                  value={crypto.randomUUID()}
                />
                <label>
                  {t("servicing.field.amount")}
                  <PriceInput name="amount" />
                </label>
                <Raw html={renderFields(costFields(listings))} />
                <SubmitButton icon="plus">
                  {t("servicing.action.record_cost")}
                </SubmitButton>
              </SectionFieldset>
            </CsrfForm>
          )}
          {costs.length > 0 && (
            <>
              <h2>{t("servicing.recorded_costs")}</h2>
              {renderTable(servicingCostsTable, costs, {
                context: {
                  eventId: event.id,
                  listingNames: costListingNames,
                  session,
                },
              })}
            </>
          )}
        </>
      )}
    </AdminPage>,
  );
};

export const renderServicingList = (
  session: AuthSession,
  events: ServicingEventSummary[],
  listings: ListingWithCount[],
): string =>
  String(
    <AdminPage
      active="/admin/servicing"
      session={session}
      title={t("servicing.title")}
    >
      {renderTable(servicingEventsTable, events, {
        context: fieldById("name")(listings),
        empty: t("servicing.empty"),
        rowAttrs: () => ({
          class: "servicing-event",
          "data-servicing": "true",
        }),
      })}
      <GuideFooter href="/admin/guide#servicing">
        {t("servicing.guide_link")}
      </GuideFooter>
    </AdminPage>,
  );
