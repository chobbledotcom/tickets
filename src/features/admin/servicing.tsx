/**
 * Admin servicing-event routes.
 */

import {
  buildServicingFieldSchema,
  parseServicingForm,
  renderServicingHiddenIndicator,
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
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  formatCurrency,
  parsePositiveMinorUnits,
  toMajorUnits,
} from "#shared/currency.ts";
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
  getAttendeeTextAnswers,
  getQuestionsWithListingIds,
  loadAttendeeQuestionData,
  parseQuestionAnswers,
  type QuestionWithAnswers,
} from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import { CsrfForm, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import { EditQuestions } from "#templates/admin/attendees.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

const SERVICING_FORM_ID = "servicing-form";

type ServicingPrefill = {
  quantities: Map<number, number>;
  startDate: string;
};

const emptyPrefill = (): ServicingPrefill => ({
  quantities: new Map(),
  startDate: "",
});

const listingsByIdMap = (
  listings: ListingWithCount[],
): Map<number, ListingWithCount> => new Map(listings.map((l) => [l.id, l]));

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
  const byId = listingsByIdMap(allListings);
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
  const deletedHolds = [...heldIds].filter((id) => !byId.has(id));
  return { deletedHolds, listings };
};

const firstBookingDate = (
  event: ServicingEvent | null,
  prefill: ServicingPrefill,
): string =>
  event?.bookings.find((booking) => booking.date)?.date ?? prefill.startDate;

const firstBookingDuration = (event: ServicingEvent | null): number =>
  event?.bookings.find((booking) => booking.durationDays)?.durationDays ?? 1;

const listingRows = (
  listings: ListingWithCount[],
  event: ServicingEvent | null,
  { quantities }: ServicingPrefill,
): string => {
  const formQuantities = new Map<number, number>();
  for (const listing of listings) {
    formQuantities.set(listing.id, 0);
  }
  for (const [listingId, quantity] of quantities) {
    formQuantities.set(listingId, quantity);
  }
  for (const booking of event?.bookings ?? []) {
    formQuantities.set(booking.listingId, booking.quantity!);
  }
  let rows = "";
  for (const listing of listings) {
    const inactiveMarker = listing.active ? "" : " <em>(inactive)</em>";
    rows += `<tr><td>${escapeHtml(listing.name)}${inactiveMarker}</td><td><input min="0" name="quantity_${listing.id}" type="number" value="${formQuantities.get(listing.id)!}"></td></tr>`;
  }
  return rows;
};

const costListingOptions = (listings: ListingWithCount[]): string =>
  listings
    .map(
      (listing) =>
        `<option value="${listing.id}">${escapeHtml(listing.name)}</option>`,
    )
    .join("");

const selectedQuestionIds = (
  data: Awaited<ReturnType<typeof loadAttendeeQuestionData>>,
  eventId: number,
): number[] => data?.attendeeAnswerMap.get(eventId) ?? [];

const renderServicingPage = ({
  costs = [],
  deletedHolds = [],
  event,
  listings,
  prefill = emptyPrefill(),
  questionData,
  questions,
  selectedTextAnswers,
  session,
}: {
  costs?: ServicingCostRecord[];
  deletedHolds?: number[];
  event: ServicingEvent | null;
  listings: ListingWithCount[];
  prefill?: ServicingPrefill;
  questionData?: Awaited<ReturnType<typeof loadAttendeeQuestionData>>;
  questions: QuestionWithAnswers[];
  selectedTextAnswers: Map<number, string>;
  session: AuthSession;
}): string => {
  const title = event ? event.name : "New service event";
  const rows = listingRows(listings, event, prefill);
  const listingNames = new Map(
    listings.map((listing) => [listing.id, listing.name]),
  );
  const action = event
    ? `/admin/servicing/${event.id}`
    : "/admin/servicing/new";
  const selectedAnswers = event
    ? selectedQuestionIds(questionData, event.id)
    : [];
  return String(
    <Layout title={title}>
      <AdminNav active="/admin/servicing" session={session} />
      <h1>{title}</h1>
      <Raw html={renderServicingHiddenIndicator()} />
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
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Listing</th>
                <th>Quantity</th>
              </tr>
            </thead>
            <tbody>
              <Raw html={rows} />
            </tbody>
          </table>
        </div>
        {questions.length > 0 && (
          <EditQuestions
            questions={questions}
            selectedAnswerIds={selectedAnswers}
            selectedTextAnswers={selectedTextAnswers}
          />
        )}
        <button type="submit">
          {event ? "Save Service Event" : "Create Service Event"}
        </button>
      </CsrfForm>
      {event && (
        <>
          <CsrfForm action={`/admin/servicing/${event.id}/duplicate`}>
            <button type="submit">Duplicate</button>
          </CsrfForm>
          <CsrfForm action={`/admin/servicing/${event.id}/delete`}>
            <button type="submit">Delete Service Event</button>
          </CsrfForm>
          <CsrfForm action={`/admin/servicing/${event.id}`}>
            <input
              name="cost_idempotency_key"
              type="hidden"
              value={crypto.randomUUID()}
            />
            <label>
              Amount
              <input name="amount" step="0.01" type="number" />
            </label>
            <label>
              Memo
              <input name="memo" type="text" />
            </label>
            <label>
              Listing
              <select name="target_listing_id">
                <Raw html={costListingOptions(listings)} />
              </select>
            </label>
            <button type="submit">Record Cost</button>
          </CsrfForm>
          {costs.length > 0 && (
            <div class="table-scroll">
              <h2>Recorded costs</h2>
              <table>
                <thead>
                  <tr>
                    <th>Listing</th>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Memo</th>
                    <th>Edit</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((cost) => (
                    <tr>
                      <td>{listingNames.get(cost.listingId)}</td>
                      <td>{formatDateLabel(cost.date.slice(0, 10))}</td>
                      <td>{formatCurrency(cost.amount)}</td>
                      <td>{cost.memo}</td>
                      <td>
                        <CsrfForm
                          action={`/admin/servicing/${event.id}/cost/${cost.id}`}
                        >
                          <input
                            name="amount"
                            step="0.01"
                            type="number"
                            value={toMajorUnits(cost.amount)}
                          />
                          <button type="submit">Edit</button>
                        </CsrfForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Layout>,
  );
};

const serviceEventListRows = (
  events: Awaited<ReturnType<typeof getAllServicingEvents>>,
  listings: ListingWithCount[],
): string => {
  const listingNames = new Map(
    listings.map((listing) => [listing.id, listing.name]),
  );
  let rows = "";
  for (const event of events) {
    // One row per service event: a multi-listing hold's listings are joined
    // inside the Listing cell, and its quantity is the event total — not one
    // row per booking line.
    const date = event.date === null ? "" : formatDateLabel(event.date);
    const listingsCell = event.bookings
      .map((booking) => escapeHtml(listingNames.get(booking.listingId) ?? ""))
      .filter(Boolean)
      .join(", ");
    rows += `<tr class="servicing-event" data-servicing="true"><td><a href="/admin/servicing/${event.id}">${escapeHtml(event.name)}</a></td><td>${date}</td><td>${listingsCell}</td><td>${event.totalQuantity}</td></tr>`;
  }
  return rows;
};

const renderServicingList = async (session: AuthSession): Promise<string> => {
  const [listings, events] = await Promise.all([
    getAllListings(),
    getAllServicingEvents(await requireRequestPrivateKey()),
  ]);
  const rows = serviceEventListRows(events, listings);
  return String(
    <Layout title="Servicing">
      <AdminNav active="/admin/servicing" session={session} />
      <h1>Servicing</h1>
      <p>
        <a href="/admin/servicing/new">New service event</a>
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Date</th>
              <th>Listings</th>
              <th>Quantity</th>
            </tr>
          </thead>
          <tbody>
            {rows ? (
              <Raw html={rows} />
            ) : (
              <tr>
                <td colspan="4">No service events yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
};

const loadCreateQuestions = async (
  listings: ListingWithCount[],
): Promise<QuestionWithAnswers[]> =>
  (await getQuestionsWithListingIds(listings.map((listing) => listing.id)))
    .questions;

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
    questions: await loadCreateQuestions(listings),
    selectedTextAnswers: new Map(),
    session,
  });
};

const loadEditPage = async (
  id: number,
  session: AuthSession,
): Promise<string | null> => {
  const event = await getServicingEvent(id);
  if (!event) return null;
  const privateKey = await requireRequestPrivateKey();
  const { deletedHolds, listings } = editPageListings(
    await getAllListings(),
    event,
  );
  const listingIds = event.bookings.map((booking) => booking.listingId);
  const questionData = await loadAttendeeQuestionData(
    listingIds,
    [id],
    privateKey,
  );
  return renderServicingPage({
    costs: await getServicingCosts(id),
    deletedHolds,
    event,
    listings,
    questionData,
    questions: questionData?.questions ?? [],
    selectedTextAnswers: await getAttendeeTextAnswers(id, privateKey),
    session,
  });
};

const handleServicingNewGet: TypedRouteHandler<"GET /admin/servicing/new"> = (
  request,
) =>
  requireSessionOr(request, async (session) => {
    applyFlash(request);
    return htmlResponse(await renderCreate(request, session));
  });

const handleServicingListGet: TypedRouteHandler<"GET /admin/servicing"> = (
  request,
) =>
  requireSessionOr(request, async (session) => {
    applyFlash(request);
    return htmlResponse(await renderServicingList(session));
  });

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
  const listings = await getAllListings();
  const parsed = parseServicingForm(form, listingsByIdMap(listings));
  const input = toServicingCreateInput(parsed);
  const questions = await getQuestionsWithListingIds(
    input.bookings.map((booking) => booking.listingId),
  );
  return {
    ...input,
    questionAnswers: parseQuestionAnswers({ optional: true })(
      form,
      questions.questions,
    ),
  };
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
  await recordServiceCost({
    amount,
    listingId,
    memo: form.getString("memo"),
    occurredAt,
    reference: form.getString("cost_idempotency_key") || undefined,
    servicingId: id,
  });
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
    try {
      const updated = await updateServicingEvent(
        id,
        await parseCreateInput(form),
      );
      return redirect(
        `/admin/servicing/${updated.id}`,
        `Updated ${updated.name}`,
        true,
      );
    } catch (err) {
      return redirect(`/admin/servicing/${id}`, (err as Error).message, false);
    }
  });

const handleServicingDeletePost: TypedRouteHandler<
  "POST /admin/servicing/:id/delete"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, async () => {
    if (!(await getServicingEvent(id))) return notFoundResponse();
    await deleteServicingEvent(id);
    return redirect("/admin/", "Deleted service event", true);
  });

const handleServicingDuplicatePost: TypedRouteHandler<
  "POST /admin/servicing/:id/duplicate"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, async () => {
    if (!(await getServicingEvent(id))) return notFoundResponse();
    try {
      const copy = await duplicateServicingEvent(id);
      return redirect(
        `/admin/servicing/${copy.id}`,
        `Duplicated ${copy.name}`,
        true,
      );
    } catch (err) {
      return redirect(`/admin/servicing/${id}`, (err as Error).message, false);
    }
  });

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

export const servicingRoutes = defineRoutes({
  "GET /admin/servicing": handleServicingListGet,
  "GET /admin/servicing/:id": handleServicingGet,
  "GET /admin/servicing/new": handleServicingNewGet,
  "POST /admin/servicing/:id": handleServicingPost,
  "POST /admin/servicing/:id/cost/:costId": handleServicingCostPost,
  "POST /admin/servicing/:id/delete": handleServicingDeletePost,
  "POST /admin/servicing/:id/duplicate": handleServicingDuplicatePost,
  "POST /admin/servicing/new": handleServicingNewPost,
});
