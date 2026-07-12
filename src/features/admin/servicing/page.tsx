import { filter, map } from "#fp";
import { t } from "#i18n";
import type { AuthSession } from "#routes/auth.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import type {
  ServicingCostRecord,
  ServicingEvent,
} from "#shared/db/attendees/servicing.ts";
import { CsrfForm, type Field, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { isOwnerRole, type ListingWithCount } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { WritableLink } from "#templates/admin/writable-only.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";
import { buildServicingFieldSchema } from "./form-model.ts";

const SERVICING_FORM_ID = "servicing-form";

export type ServicingPrefill = {
  quantities: Map<number, number>;
  startDate: string;
};

export const emptyServicingPrefill = (): ServicingPrefill => ({
  quantities: new Map(),
  startDate: "",
});

export const servicingListingsById = (
  listings: ListingWithCount[],
): Map<number, ListingWithCount> =>
  new Map(
    map((listing: ListingWithCount) => [listing.id, listing] as const)(
      listings,
    ),
  );

const listingNamesById = (listings: ListingWithCount[]): Map<number, string> =>
  new Map(
    map((listing: ListingWithCount) => [listing.id, listing.name] as const)(
      listings,
    ),
  );

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
  const byId = servicingListingsById(allListings);
  const heldIds = new Set(
    map((booking: ServicingEvent["bookings"][number]) => booking.listingId)(
      event.bookings,
    ),
  );
  const inactiveHolds = filter(
    (listing: ListingWithCount) => !listing.active && heldIds.has(listing.id),
  )(allListings);
  return {
    deletedHolds: filter((id: number) => !byId.has(id))([...heldIds]),
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
): Map<number, number> => {
  const formQuantities = new Map<number, number>(
    map((listing: ListingWithCount) => [listing.id, 0] as const)(listings),
  );
  for (const [listingId, quantity] of quantities) {
    formQuantities.set(listingId, quantity);
  }
  for (const booking of event?.bookings ?? []) {
    formQuantities.set(booking.listingId, booking.quantity!);
  }
  return formQuantities;
};

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
            { header: t("servicing.column.listing") },
            { header: t("servicing.column.quantity") },
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
          <CsrfForm action={`/admin/servicing/${event.id}/duplicate`}>
            <SubmitButton icon="rotate-ccw">
              {t("servicing.action.duplicate")}
            </SubmitButton>
          </CsrfForm>
          <CsrfForm action={`/admin/servicing/${event.id}/delete`}>
            <SubmitButton class="danger" icon="trash-2">
              {t("servicing.action.delete_event")}
            </SubmitButton>
          </CsrfForm>
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
                  { header: t("servicing.column.listing") },
                  { header: t("servicing.column.date") },
                  { class: "amount", header: t("servicing.column.amount") },
                  { header: t("servicing.column.note") },
                  { header: t("servicing.column.actions") },
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

type ServicingListEvent = {
  bookings: { listingId: number }[];
  date: string | null;
  id: number;
  name: string;
  totalQuantity: number;
};

const serviceEventListRows = (
  events: ServicingListEvent[],
  listings: ListingWithCount[],
) => {
  const listingNames = listingNamesById(listings);
  return map((event: ServicingListEvent) => {
    const names = map(
      (booking: { listingId: number }) =>
        listingNames.get(booking.listingId) ?? t("servicing.deleted_listing"),
    )(event.bookings).join(", ");
    return (
      <tr class="servicing-event" data-servicing="true">
        <td>
          <WritableLink href={adminPath("servicingEdit", { id: event.id })}>
            {event.name}
          </WritableLink>
        </td>
        <td>{event.date === null ? "" : formatDateLabel(event.date)}</td>
        <td>{names}</td>
        <td>{event.totalQuantity}</td>
      </tr>
    );
  })(events);
};

export const renderServicingList = (
  session: AuthSession,
  events: ServicingListEvent[],
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
          { header: t("servicing.column.name") },
          { header: t("servicing.column.date") },
          { header: t("servicing.column.listings") },
          { header: t("servicing.column.quantity") },
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
