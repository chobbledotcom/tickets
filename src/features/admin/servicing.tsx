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
import { toMinorUnits } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  createServicingEvent,
  deleteServicingEvent,
  duplicateServicingEvent,
  editServiceCost,
  getAllServicingEvents,
  getServicingEvent,
  recordServiceCost,
  type ServicingEvent,
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
    rows += `<tr><td>${listing.name}</td><td><input min="0" name="quantity_${listing.id}" type="number" value="${formQuantities.get(listing.id)!}"></td></tr>`;
  }
  return rows;
};

const costListingOptions = (listings: ListingWithCount[]): string =>
  listings
    .map((listing) => `<option value="${listing.id}">${listing.name}</option>`)
    .join("");

const selectedQuestionIds = (
  data: Awaited<ReturnType<typeof loadAttendeeQuestionData>>,
  eventId: number,
): number[] => data?.attendeeAnswerMap.get(eventId) ?? [];

const renderServicingPage = ({
  event,
  listings,
  prefill = emptyPrefill(),
  questionData,
  questions,
  selectedTextAnswers,
  session,
}: {
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
    const date = event.date === null ? "" : formatDateLabel(event.date);
    const listing = listingNames.get(event.listingId) ?? "";
    rows += `<tr class="servicing-event" data-servicing="true"><td><a href="/admin/servicing/${event.id}">${escapeHtml(event.name)}</a></td><td>${date}</td><td>${escapeHtml(listing)}</td><td>${event.quantity}</td></tr>`;
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
              <th>Listing</th>
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
  const listings = activeListings(await getAllListings());
  const listingIds = event.bookings.map((booking) => booking.listingId);
  const questionData = await loadAttendeeQuestionData(
    listingIds,
    [id],
    privateKey,
  );
  return renderServicingPage({
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

const handleCostPost = async (
  id: number,
  form: FormParams,
): Promise<Response | null> => {
  if (!form.has("amount")) return null;
  const amount = toMinorUnits(Number(form.getString("amount")));
  await recordServiceCost({
    amount,
    listingId: Number(form.getString("target_listing_id")),
    memo: form.getString("memo"),
    occurredAt: new Date().toISOString(),
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
    const event = await createServicingEvent(await parseCreateInput(form));
    return redirect(
      `/admin/servicing/${event.id}`,
      `Created ${event.name}`,
      true,
    );
  });

const handleServicingPost: TypedRouteHandler<"POST /admin/servicing/:id"> = (
  request,
  { id },
) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    if (!(await getServicingEvent(id))) return notFoundResponse();
    const costResponse = await handleCostPost(id, form);
    if (costResponse) return costResponse;
    const updated = await updateServicingEvent(
      id,
      await parseCreateInput(form),
    );
    return redirect(
      `/admin/servicing/${updated.id}`,
      `Updated ${updated.name}`,
      true,
    );
  });

const handleServicingDeletePost: TypedRouteHandler<
  "POST /admin/servicing/:id/delete"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, async () => {
    await deleteServicingEvent(id);
    return redirect("/admin/", "Deleted service event", true);
  });

const handleServicingDuplicatePost: TypedRouteHandler<
  "POST /admin/servicing/:id/duplicate"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, async () => {
    const copy = await duplicateServicingEvent(id);
    return redirect(
      `/admin/servicing/${copy.id}`,
      `Duplicated ${copy.name}`,
      true,
    );
  });

const handleServicingCostPost: TypedRouteHandler<
  "POST /admin/servicing/:id/cost/:costId"
> = (request, { id, costId }) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    if (!(await getServicingEvent(id))) return notFoundResponse();
    const amount = toMinorUnits(Number(form.getString("amount")));
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
