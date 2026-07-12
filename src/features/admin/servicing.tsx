import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin servicing-event routes.
 */

import { byId, map } from "#fp";
import {
  buildServicingFieldSchema,
  parseServicingForm,
  toServicingCreateInput,
} from "#routes/admin/servicing-form-model.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  costBelongsToServicing,
  createServicingEvent,
  deleteServicingEvent,
  duplicateServicingEvent,
  editServiceCost,
  getAllServicingEvents,
  getServicingCosts,
  getServicingEvent,
  recordServiceCost,
  type ServicingCostRecord,
  type ServicingEvent,
  servicingHoldsListing,
  updateServicingEvent,
} from "#shared/db/attendees/servicing.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  applyDemoOverrides,
  SERVICING_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import { CsrfForm, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import {
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { isOwner, type ListingWithCount } from "#shared/types.ts";
import { parsePositiveMinorUnits } from "#shared/validation/money.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { WritableLink } from "#templates/admin/writable-only.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";

const SERVICING_FORM_ID = "servicing-form";

type ServicingPrefill = {
  quantities: Map<number, number>;
  startDate: string;
};

const emptyPrefill = (): ServicingPrefill => ({
  quantities: new Map(),
  startDate: "",
});

const listingsByNameMap = (listings: ListingWithCount[]): Map<number, string> =>
  new Map(listings.map((listing) => [listing.id, listing.name]));

const activeListings = (listings: ListingWithCount[]): ListingWithCount[] =>
  listings.filter((listing) => listing.active);

/**
 * The listings an edit page must render bookings for: every active listing
 * (the operator can move capacity onto any of them) PLUS every listing the
 * event already holds, even when that listing has since been deactivated — so
 * the held line still renders its quantity input and saving the form preserves
 * it instead of silently dropping the hold. A listing the event holds that has
 * been deleted entirely (no record left) can't render a row, so its id is
 * returned separately for a "will be removed on save" indicator — making the
 * repair explicit rather than a silent drop.
 */
const editPageListings = (
  allListings: ListingWithCount[],
  event: ServicingEvent,
): { deletedHolds: number[]; listings: ListingWithCount[] } => {
  const listingById = byId(allListings);
  const heldIds = new Set(event.bookings.map((booking) => booking.listingId));
  const listings = [...activeListings(allListings)];
  // Add any held-but-inactive listings so the held line still renders (with an
  // "(inactive)" marker) and is preserved on save. Active held listings are
  // already in `listings` from `activeListings`; inactive ones were filtered out,
  // so they're added here.
  for (const listing of allListings) {
    if (!listing.active && heldIds.has(listing.id)) {
      listings.push(listing);
    }
  }
  const deletedHolds = [...heldIds].filter((id) => !listingById.has(id));
  return { deletedHolds, listings };
};

const firstBookingDate = (
  event: ServicingEvent | null,
  prefill: ServicingPrefill,
): string =>
  event?.bookings.find((booking) => booking.date)?.date ?? prefill.startDate;

const firstBookingDuration = (event: ServicingEvent | null): number =>
  event?.bookings.find((booking) => booking.durationDays)?.durationDays ?? 1;

/** The per-listing quantity to prefill: 0 by default, overridden by any prefill
 *  selection, then by the event's existing booking for that listing. */
const listingFormQuantities = (
  listings: ListingWithCount[],
  event: ServicingEvent | null,
  quantities: Map<number, number>,
): Map<number, number> => {
  const formQuantities = new Map<number, number>(
    listings.map((listing) => [listing.id, 0]),
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
  return listings.map((listing) => (
    <tr>
      <td>
        {listing.name}
        {listing.active ? "" : <em> (inactive)</em>}
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
  ));
};

const costListingOptions = (listings: ListingWithCount[]) =>
  listings.map((listing) => (
    <option value={String(listing.id)}>{listing.name}</option>
  ));

const renderServicingPage = ({
  costs = [],
  deletedHolds = [],
  event,
  listings,
  prefill = emptyPrefill(),
  session,
}: {
  costs?: ServicingCostRecord[];
  deletedHolds?: number[];
  event: ServicingEvent | null;
  listings: ListingWithCount[];
  prefill?: ServicingPrefill;
  session: AuthSession;
}): string => {
  const title = event ? event.name : "New service event";
  const listingNames = listingsByNameMap(listings);
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
          {deletedHolds.length} held listing(s) no longer exist and will be
          removed from this service event when you save.
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
          columns={[{ header: "Listing" }, { header: "Quantity" }]}
          rows={listingRows(listings, event, prefill)}
        />
        <SubmitButton icon={event ? "save" : "plus"}>
          {event ? "Save Service Event" : "Create Service Event"}
        </SubmitButton>
      </CsrfForm>
      {event && (
        <>
          <CsrfForm action={`/admin/servicing/${event.id}/duplicate`}>
            <SubmitButton icon="rotate-ccw">Duplicate</SubmitButton>
          </CsrfForm>
          <CsrfForm action={`/admin/servicing/${event.id}/delete`}>
            <SubmitButton class="danger" icon="trash-2">
              Delete Service Event
            </SubmitButton>
          </CsrfForm>
          <h2>Money out</h2>
          <p>
            Record what this service event cost, against the listing it served.
          </p>
          <CsrfForm action={`/admin/servicing/${event.id}`}>
            <input
              name="cost_idempotency_key"
              type="hidden"
              value={crypto.randomUUID()}
            />
            <label>
              Amount
              <PriceInput name="amount" />
            </label>
            <label>
              Memo
              <input name="memo" type="text" />
            </label>
            <label>
              Listing
              <select name="target_listing_id">
                {costListingOptions(listings)}
              </select>
            </label>
            <SubmitButton icon="plus">Record Cost</SubmitButton>
          </CsrfForm>
          {costs.length > 0 && (
            <>
              <h2>Recorded outgoings</h2>
              <DataTable
                columns={[
                  { header: "Listing" },
                  { header: "Date" },
                  { class: "amount", header: "Amount" },
                  { header: "Memo" },
                  { header: "Actions" },
                ]}
                rows={map((cost: ServicingCostRecord) => {
                  const listingName = listingNames.get(cost.listingId);
                  const ledgerHref =
                    isOwner(session) && listingName !== undefined
                      ? listingLedgerHref(cost.listingId)
                      : null;
                  return [
                    ledgerHref === null ? (
                      listingName === undefined ? (
                        "Deleted listing"
                      ) : (
                        listingName
                      )
                    ) : (
                      <a href={ledgerHref}>{listingName}</a>
                    ),
                    formatDateLabel(cost.date.slice(0, 10)),
                    formatCurrency(cost.amount),
                    cost.memo,
                    <>
                      <CsrfForm
                        action={`/admin/servicing/${event.id}/cost/${cost.id}`}
                      >
                        <PriceInput
                          name="amount"
                          value={toMajorUnits(cost.amount)}
                        />
                        <SubmitButton icon="save">Edit</SubmitButton>
                      </CsrfForm>
                      {ledgerHref !== null && (
                        <a href={ledgerHref}>View in ledger</a>
                      )}
                    </>,
                  ];
                })(costs)}
              />
            </>
          )}
        </>
      )}
    </AdminPage>,
  );
};

const serviceEventListRows = (
  events: Awaited<ReturnType<typeof getAllServicingEvents>>,
  listings: ListingWithCount[],
) => {
  const listingNames = listingsByNameMap(listings);
  // One row per service event: a multi-listing hold's listings are joined
  // inside the Listing cell, and its quantity is the event total — not one row
  // per booking line. JSX escapes each cell (the listing names are joined raw,
  // then escaped as one string — the comma separators carry no markup).
  return events.map((event) => {
    const listingsCell = event.bookings
      .map((booking) => listingNames.get(booking.listingId) ?? "")
      .filter(Boolean)
      .join(", ");
    return (
      <tr class="servicing-event" data-servicing="true">
        <td>
          <WritableLink href={adminPath("servicingEdit", { id: event.id })}>
            {event.name}
          </WritableLink>
        </td>
        <td>{event.date === null ? "" : formatDateLabel(event.date)}</td>
        <td>{listingsCell}</td>
        <td>{event.totalQuantity}</td>
      </tr>
    );
  });
};

const renderServicingList = async (session: AuthSession): Promise<string> => {
  const [listings, events] = await Promise.all([
    getAllListings(),
    getAllServicingEvents(await requireRequestPrivateKey()),
  ]);
  const rows = serviceEventListRows(events, listings);
  return String(
    <AdminPage active="/admin/servicing" session={session} title="Servicing">
      <DataTable
        columns={[
          { header: "Name" },
          { header: "Date" },
          { header: "Listings" },
          { header: "Quantity" },
        ]}
        rows={
          rows.length > 0
            ? rows
            : [
                <tr>
                  <td colspan="4">No service events yet</td>
                </tr>,
              ]
        }
      />
      <GuideFooter href="/admin/guide#servicing">Servicing guide</GuideFooter>
    </AdminPage>,
  );
};

const createPrefillFromRequest = (request: Request): ServicingPrefill => {
  const params = new URL(request.url).searchParams;
  return {
    quantities: selectedListingQuantities(params),
    startDate: selectedStartDate(params),
  };
};

const renderCreate = async (
  request: Request,
  session: AuthSession,
): Promise<string> => {
  const listings = activeListings(await getAllListings());
  return renderServicingPage({
    event: null,
    listings,
    prefill: createPrefillFromRequest(request),
    session,
  });
};

const loadEditPage = async (
  id: number,
  session: AuthSession,
): Promise<string | null> => {
  const event = await getServicingEvent(id);
  if (!event) return null;
  const { deletedHolds, listings } = editPageListings(
    await getAllListings(),
    event,
  );
  return renderServicingPage({
    costs: await getServicingCosts(id),
    deletedHolds,
    event,
    listings,
    session,
  });
};

const renderFlashHtml = (
  request: Request,
  render: (session: AuthSession) => Promise<string>,
): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    applyFlash(request);
    return htmlResponse(await render(session));
  });

const handleServicingNewGet: TypedRouteHandler<"GET /admin/servicing/new"> = (
  request,
) => renderFlashHtml(request, (session) => renderCreate(request, session));

const handleServicingListGet: TypedRouteHandler<"GET /admin/servicing"> = (
  request,
) => renderFlashHtml(request, renderServicingList);

const handleServicingGet: TypedRouteHandler<"GET /admin/servicing/:id"> = (
  request,
  { id },
) =>
  requireSessionOr(request, async (session) => {
    applyFlash(request);
    const page = await loadEditPage(id, session);
    return page ? htmlResponse(page) : notFoundResponse();
  });

const parseCreateInput = async (form: FormParams) => {
  // In demo mode, swap the operator's submitted servicing name for a demo
  // servicing reason before parsing — mirroring the attendee form's
  // applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS). SERVICING_DEMO_FIELDS maps
  // only `name` (to a job, not a person), and it's a no-op outside demo mode.
  applyDemoOverrides(form, SERVICING_DEMO_FIELDS);
  const listings = await getAllListings();
  const parsed = parseServicingForm(form, byId(listings));
  return toServicingCreateInput(parsed);
};

const COST_AMOUNT_LABEL = "cost amount";

const handleCostPost = async (
  id: number,
  form: FormParams,
  event: ServicingEvent,
): Promise<Response | null> => {
  if (!form.has("amount")) return null;
  const amount = parsePositiveMinorUnits(form.getString("amount"));
  const listingId = parsePositiveIntId(form.getString("target_listing_id"));
  if (amount === null || listingId === null) {
    return redirect(
      `/admin/servicing/${id}`,
      `Please enter a valid positive ${COST_AMOUNT_LABEL} and target listing.`,
      false,
    );
  }
  if (!(await servicingHoldsListing(id, listingId))) {
    return redirect(
      `/admin/servicing/${id}`,
      "The service event does not hold that listing.",
      false,
    );
  }
  const serviceDate = event.bookings[0]?.date;
  const occurredAt = serviceDate
    ? `${serviceDate}T00:00:00.000Z`
    : new Date().toISOString();
  try {
    await recordServiceCost({
      amount,
      listingId,
      memo: form.getString("memo"),
      occurredAt,
      reference: form.getString("cost_idempotency_key") || undefined,
      servicingId: id,
    });
  } catch (err) {
    // A reused idempotency key whose payload changed (or any other recording
    // failure) is a recoverable form error, not a 500.
    return redirect(`/admin/servicing/${id}`, (err as Error).message, false);
  }
  return redirect(
    `/admin/servicing/${id}`,
    `Recorded cost ${form.getString("amount")}`,
    true,
  );
};

const handleServicingNewPost: TypedRouteHandler<"POST /admin/servicing/new"> = (
  request,
) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    try {
      const event = await createServicingEvent(await parseCreateInput(form));
      return redirect(
        `/admin/servicing/${event.id}`,
        `Created ${event.name}`,
        true,
      );
    } catch (err) {
      return redirect("/admin/servicing/new", (err as Error).message, false);
    }
  });

const handleServicingPost: TypedRouteHandler<"POST /admin/servicing/:id"> = (
  request,
  { id },
) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    const event = await getServicingEvent(id);
    if (!event) return notFoundResponse();
    const costResponse = await handleCostPost(id, form, event);
    if (costResponse) return costResponse;
    return redirectServicingResult(
      id,
      async () => updateServicingEvent(id, await parseCreateInput(form)),
      (updated) => `Updated ${updated.name}`,
    );
  });

const handleServicingDeletePost: TypedRouteHandler<
  "POST /admin/servicing/:id/delete"
> = (request, { id }) =>
  withServicingEvent(request, id, async () => {
    await deleteServicingEvent(id);
    return redirect("/admin/", "Deleted service event", true);
  });

const handleServicingDuplicatePost: TypedRouteHandler<
  "POST /admin/servicing/:id/duplicate"
> = (request, { id }) =>
  withServicingEvent(request, id, async () =>
    redirectServicingResult(
      id,
      () => duplicateServicingEvent(id),
      (copy) => `Duplicated ${copy.name}`,
    ),
  );

const handleServicingCostPost: TypedRouteHandler<
  "POST /admin/servicing/:id/cost/:costId"
> = (request, { id, costId }) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    if (!(await getServicingEvent(id))) return notFoundResponse();
    const amount = parsePositiveMinorUnits(form.getString("amount"));
    if (amount === null) {
      return redirect(
        `/admin/servicing/${id}`,
        `Please enter a valid positive ${COST_AMOUNT_LABEL}.`,
        false,
      );
    }
    if (!(await costBelongsToServicing(costId, id))) {
      return notFoundResponse();
    }
    await editServiceCost(costId, { amount }, id);
    return redirect(`/admin/servicing/${id}`, "Updated service cost", true);
  });

const withServicingEvent = (
  request: Request,
  id: number,
  body: () => Promise<Response>,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, async () => {
    const existing = await getServicingEvent(id);
    if (!existing) return notFoundResponse();
    return body();
  });

const redirectServicingResult = async <T extends { id: number; name: string }>(
  id: number,
  action: () => Promise<T>,
  successMessage: (result: T) => string,
): Promise<Response> => {
  try {
    const result = await action();
    return redirect(
      `/admin/servicing/${result.id}`,
      successMessage(result),
      true,
    );
  } catch (err) {
    return redirect(`/admin/servicing/${id}`, (err as Error).message, false);
  }
};

export const adminHandlers = handlersFor("servicing")({
  getServicing: handleServicingListGet,
  getServicingById: handleServicingGet,
  getServicingNew: handleServicingNewGet,
  postServicingById: handleServicingPost,
  postServicingByIdCostByCostId: handleServicingCostPost,
  postServicingByIdDelete: handleServicingDeletePost,
  postServicingByIdDuplicate: handleServicingDuplicatePost,
  postServicingNew: handleServicingNewPost,
});
