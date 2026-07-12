/** Admin servicing-event route shell. */

import { map, unique } from "#fp";
import { t } from "#i18n";
import { handlersFor } from "#routes/admin/handlers.ts";
import {
  normalizeServicingForSave,
  parseServicingForm,
} from "#routes/admin/servicing/form-model.ts";
import {
  activeServicingListings,
  listingsForServicingEdit,
  renderServicingList,
  renderServicingPage,
  type ServicingPrefill,
  servicingListingsById,
} from "#routes/admin/servicing/page.tsx";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
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
import {
  getAllListings,
  getListingNamesByIds,
} from "#shared/db/listings/records.ts";
import {
  applyDemoOverrides,
  SERVICING_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { parsePositiveMinorUnits } from "#shared/validation/money.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";

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
): Promise<string> =>
  renderServicingPage({
    event: null,
    listings: activeServicingListings(await getAllListings()),
    prefill: createPrefillFromRequest(request),
    session,
  });

const loadEditPage = async (
  id: number,
  session: AuthSession,
): Promise<string | null> => {
  const event = await getServicingEvent(id);
  if (!event) return null;
  const [{ deletedHolds, listings }, costs] = await Promise.all([
    getAllListings().then((all) => listingsForServicingEdit(all, event)),
    getServicingCosts(id),
  ]);
  const costListingNames = await getListingNamesByIds(
    unique(map((cost: ServicingCostRecord) => cost.listingId)(costs)),
  );
  return renderServicingPage({
    costListingNames,
    costs,
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
) =>
  renderFlashHtml(request, async (session) => {
    const [listings, events] = await Promise.all([
      getAllListings(),
      getAllServicingEvents(await requireRequestPrivateKey()),
    ]);
    return renderServicingList(session, events, listings);
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
  applyDemoOverrides(form, SERVICING_DEMO_FIELDS);
  const listings = await getAllListings();
  return normalizeServicingForSave(
    parseServicingForm(form, servicingListingsById(listings)),
  );
};

const servicingErrorRedirect = (id: number, error: unknown): Response =>
  redirect(`/admin/servicing/${id}`, (error as Error).message, false);

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
      t("servicing.error.invalid_cost"),
      false,
    );
  }
  if (!(await servicingHoldsListing(id, listingId))) {
    return redirect(
      `/admin/servicing/${id}`,
      t("servicing.error.listing_not_held"),
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
    return servicingErrorRedirect(id, err);
  }
  return redirect(
    `/admin/servicing/${id}`,
    t("servicing.success.cost_recorded", { amount: form.getString("amount") }),
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
        t("servicing.success.created", { name: event.name }),
        true,
      );
    } catch (err) {
      return redirect("/admin/servicing/new", (err as Error).message, false);
    }
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
    return servicingErrorRedirect(id, err);
  }
};

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
      (updated) => t("servicing.success.updated", { name: updated.name }),
    );
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

const handleServicingDeletePost: TypedRouteHandler<
  "POST /admin/servicing/:id/delete"
> = (request, { id }) =>
  withServicingEvent(request, id, async () => {
    await deleteServicingEvent(id);
    return redirect("/admin/", t("servicing.success.deleted"), true);
  });

const handleServicingDuplicatePost: TypedRouteHandler<
  "POST /admin/servicing/:id/duplicate"
> = (request, { id }) =>
  withServicingEvent(request, id, async () =>
    redirectServicingResult(
      id,
      () => duplicateServicingEvent(id),
      (copy) => t("servicing.success.duplicated", { name: copy.name }),
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
        t("servicing.error.invalid_cost_amount"),
        false,
      );
    }
    if (!(await costBelongsToServicing(costId, id))) return notFoundResponse();
    await editServiceCost(costId, { amount }, id);
    return redirect(
      `/admin/servicing/${id}`,
      t("servicing.success.cost_updated"),
      true,
    );
  });

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
