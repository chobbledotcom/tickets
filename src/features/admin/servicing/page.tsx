import { filter, identity, map, mapBy } from "#fp";
import { t } from "#i18n";
import type { AuthSession } from "#routes/auth.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import type {
  ServicingCostRecord,
  ServicingEvent,
  ServicingEventSummary,
} from "#shared/db/attendees/servicing.ts";
import { CsrfForm, type Field, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { isOwnerRole, type ListingWithCount } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import {
  ServicingEventEditLink,
  servicingEventDateLabel,
} from "#templates/admin/servicing-events.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import { DataTable, textCol } from "#templates/components/data-table.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { buildServicingFieldSchema } from "./form-model.ts";

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
  const listingById = mapBy("id", identity<ListingWithCount>)(allListings);
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

const listingRows = (
  listings: ListingWithCount[],
  event: ServicingEvent | null,
  { quantities }: ServicingPrefill,
) => {
  const formQuantities = listingFormQuantities(listings, event, quantities);
  return map((listing: ListingWithCount) => (
    <tr>
      <td>
        {listing.name}
        {listing.active ? "" : <em> {t("servicing.inactive")}</em>}
      </td>
      <td>
        <input
          min="0"
          name={`quantity_${listing.id}`}
          type="number"
          value={String(formQuantities.get(listing.id)!)}
        />
      </td>
    </tr>
  ))(listings);
};

const costFields = (listings: ListingWithCount[]): Field[] => [
  {
    label: t("servicing.field.note"),
    name: "memo",
    type: "text",
  },
  {
    label: t("servicing.field.listing"),
    name: "target_listing_id",
    options: map((listing: ListingWithCount) => ({
      label: listing.name,
      value: String(listing.id),
    }))(listings),
    type: "select",
  },
];

const costRows = (
  costs: ServicingCostRecord[],
  listingNames: Map<number, string>,
  eventId: number,
  session: AuthSession,
) =>
  map((cost: ServicingCostRecord) => {
    const listingName = listingNames.get(cost.listingId);
    const ledgerHref =
      isOwnerRole(session.adminLevel) && listingName !== undefined
        ? listingLedgerHref(cost.listingId)
        : null;
    return [
      ledgerHref === null ? (
        (listingName ?? t("servicing.deleted_listing"))
      ) : (
        <a href={ledgerHref}>{listingName}</a>
      ),
      formatDateLabel(cost.date.slice(0, 10)),
      formatCurrency(cost.amount),
      cost.memo,
      <>
        <CsrfForm action={`/admin/servicing/${eventId}/cost/${cost.id}`}>
          <PriceInput name="amount" value={toMajorUnits(cost.amount)} />
          <SubmitButton icon="save">{t("servicing.action.edit")}</SubmitButton>
        </CsrfForm>
        {ledgerHref !== null && (
          <a href={ledgerHref}>{t("servicing.action.view_money_history")}</a>
        )}
      </>,
    ];
  })(costs);

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
        <DataTable
          columns={[
            textCol("servicing.column.listing"),
            textCol("servicing.column.quantity"),
          ]}
          rows={listingRows(listings, event, prefill)}
        />
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
          {costs.length > 0 && (
            <>
              <h2>{t("servicing.recorded_costs")}</h2>
              <DataTable
                columns={[
                  textCol("servicing.column.listing"),
                  textCol("servicing.column.date"),
                  { class: "amount", header: t("servicing.column.amount") },
                  textCol("servicing.column.note"),
                  textCol("servicing.column.actions"),
                ]}
                rows={costRows(costs, costListingNames, event.id, session)}
              />
            </>
          )}
        </>
      )}
    </AdminPage>,
  );
};

const serviceEventListRows = (
  events: ServicingEventSummary[],
  listings: ListingWithCount[],
) => {
  const listingNames = mapBy(
    "id",
    (listing: ListingWithCount) => listing.name,
  )(listings);
  return map((event: ServicingEventSummary) => {
    const names = map(
      (booking: { listingId: number }) =>
        listingNames.get(booking.listingId) ?? t("servicing.deleted_listing"),
    )(event.bookings).join(", ");
    return (
      <tr class="servicing-event" data-servicing="true">
        <td>
          <ServicingEventEditLink event={event} />
        </td>
        <td>{servicingEventDateLabel(event.date)}</td>
        <td>{names}</td>
        <td>{event.totalQuantity}</td>
      </tr>
    );
  })(events);
};

export const renderServicingList = (
  session: AuthSession,
  events: ServicingEventSummary[],
  listings: ListingWithCount[],
): string => {
  const rows = serviceEventListRows(events, listings);
  return String(
    <AdminPage
      active="/admin/servicing"
      session={session}
      title={t("servicing.title")}
    >
      <DataTable
        columns={[
          textCol("servicing.column.name"),
          textCol("servicing.column.date"),
          textCol("servicing.column.listings"),
          textCol("servicing.column.quantity"),
        ]}
        rows={
          rows.length > 0
            ? rows
            : [
                <tr>
                  <td colspan="4">{t("servicing.empty")}</td>
                </tr>,
              ]
        }
      />
      <GuideFooter href="/admin/guide#servicing">
        {t("servicing.guide_link")}
      </GuideFooter>
    </AdminPage>,
  );
};
