/**
 * Core ticket submission orchestrator
 */

import { reduce } from "#fp";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import { errorRedirect, redirectResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { saveEventAnswers } from "#shared/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { isPaidEvent } from "#shared/types.ts";
import {
  type TicketFormValues,
  tryValidateTicketFields,
} from "#templates/fields.ts";
import type { TicketEvent } from "#templates/public.tsx";
import {
  buildEventAnswerMap,
  extractContact,
  getTicketFieldsSetting,
  parseCustomPrice,
  parseQuantities,
  parseQuestionAnswers,
  ticketFormErrorResponse,
  ticketResponse,
  validateSubmittedDate,
} from "./ticket-form.ts";
import {
  anyRequiresPayment,
  buildRegistrationItems,
  checkAvailability,
  getTicketContext,
  handlePaymentFlow,
  processFreeReservation,
  withActiveEvents,
} from "./ticket-payment.ts";
import {
  applyHiddenNoindex,
  REGISTRATION_CLOSED_SUBMIT_MESSAGE,
  type TicketContextProvider,
  type TicketCtx,
} from "./types.ts";

/** Validate fields, terms and event availability. Returns Response on error, or parsed field values. */
const validateFormAndAvailability = (
  form: FormParams,
  ctx: TicketCtx,
): Response | TicketFormValues => {
  const errorResponse = ticketFormErrorResponse(ctx);
  const anyPaid = ctx.events.some((e) => isPaidEvent(e.event));
  const fieldResult = tryValidateTicketFields(
    form,
    getTicketFieldsSetting(ctx.events),
    errorResponse,
    anyPaid,
  );
  if (fieldResult instanceof Response) return fieldResult;

  if (ctx.terms && form.get("agree_terms") !== "1") {
    return errorResponse("You must agree to the terms and conditions");
  }

  const allUnavailable = ctx.events.every((e) => e.isSoldOut || e.isClosed);
  if (allUnavailable) {
    const allClosed = ctx.events.every((e) => e.isClosed);
    return errorResponse(
      allClosed
        ? REGISTRATION_CLOSED_SUBMIT_MESSAGE
        : "Sorry, not enough spots available",
    );
  }

  for (const { event, isClosed } of ctx.events) {
    const selectedQty = Number.parseInt(
      form.get(`quantity_${event.id}`) || "0",
      10,
    );
    if (isClosed && selectedQty > 0) {
      return errorResponse(REGISTRATION_CLOSED_SUBMIT_MESSAGE);
    }
  }
  return fieldResult;
};

/** Parse custom prices for pay-more events. Returns Response on validation error. */
const parseCustomPrices = (
  form: FormParams,
  ctx: TicketCtx,
  quantities: Map<number, number>,
): Response | Map<number, number> => {
  const errorResponse = ticketFormErrorResponse(ctx);
  const customPrices = new Map<number, number>();
  for (const { event } of ctx.events) {
    if (!event.can_pay_more) continue;
    const qty = quantities.get(event.id) ?? 0;
    if (qty <= 0) continue;
    const priceResult = parseCustomPrice(
      form,
      `custom_price_${event.id}`,
      event.unit_price,
      event.max_price,
    );
    if (!priceResult.ok) {
      return errorResponse(`${event.name}: ${priceResult.error}`);
    }
    customPrices.set(event.id, priceResult.price);
  }
  return customPrices;
};

/**
 * Apply signed QR-token price overrides to the custom prices map.
 *
 * QR tokens can pre-set a price for a specific event. For can_pay_more events
 * the user-submitted custom_price_{id} already populated the map in
 * parseCustomPrices and wins. For fixed-price events the signed value
 * overrides event.unit_price so admins can generate one-off bookings at any
 * price. Tokens are re-verified here to prevent tampering of the hidden field.
 */
const applyQrTokenOverride = async (
  form: FormParams,
  ctx: TicketCtx,
  customPrices: Map<number, number>,
): Promise<void> => {
  const token = form.getString("qr_token");
  if (!token || ctx.slugs.length !== 1) return;
  const payload = await verifyQrBookToken(ctx.slugs[0]!, token);
  if (!payload || payload.v < 0) return;
  for (const { event } of ctx.events) {
    if (!event.can_pay_more) customPrices.set(event.id, payload.v);
  }
};

type AnswerInfo = {
  activeQuestions: TicketCtx["questions"];
  answerIds: number[];
  selectedEventIds: Set<number>;
};

/** Compute event-answer map if answers exist */
const computeEventAnswerMap = (
  ctx: TicketCtx,
  info: AnswerInfo,
): Record<string, number[]> | undefined =>
  info.answerIds.length > 0
    ? buildEventAnswerMap(
        info.activeQuestions,
        info.answerIds,
        ctx.questionEventMap,
        info.selectedEventIds,
      )
    : undefined;

type PathParams = {
  ctx: TicketCtx;
  quantities: Map<number, number>;
  date: string | null;
  contact: ReturnType<typeof extractContact>;
  info: AnswerInfo;
};

/** Handle the paid registration path */
const handlePaidPath = async (
  request: Request,
  params: PathParams & { items: ReturnType<typeof buildRegistrationItems> },
): Promise<Response> => {
  const { ctx, quantities, date, contact, items, info } = params;
  const available = await checkAvailability(ctx.events, quantities, date);
  if (!available) {
    return ticketFormErrorResponse(ctx)(
      "Sorry, some tickets are no longer available",
    );
  }
  const eventAnswerIds = computeEventAnswerMap(ctx, info);
  const intent = { ...contact, date, eventAnswerIds, items };
  return handlePaymentFlow(request, intent, ctx);
};

/** Handle the free registration path */
const handleFreePath = async (params: PathParams): Promise<Response> => {
  const { ctx, quantities, date, contact, info } = params;
  const result = await processFreeReservation(
    ctx.events,
    quantities,
    contact,
    date,
  );
  if (!result.success) return ticketFormErrorResponse(ctx)(result.error);

  if (info.answerIds.length > 0) {
    const eventAnswerMap = buildEventAnswerMap(
      info.activeQuestions,
      info.answerIds,
      ctx.questionEventMap,
      info.selectedEventIds,
    );
    await saveEventAnswers(result.entries, eventAnswerMap);
  }

  if (ctx.events.length === 1) {
    const thankYouUrl = ctx.events[0]!.event.thank_you_url;
    if (thankYouUrl) return redirectResponse(thankYouUrl);
  }
  const token = encodeURIComponent(result.token);
  return redirectResponse(`/ticket/reserved?tokens=${token}`);
};

/** Process submitted form after CSRF and demo overrides. */
const processSubmission = async (
  request: Request,
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const errorResponse = ticketFormErrorResponse(ctx);

  const validated = validateFormAndAvailability(form, ctx);
  if (validated instanceof Response) return validated;
  const values = validated;

  const quantities = parseQuantities(form, ctx.events);
  const totalQuantity = reduce(
    (sum: number, qty: number) => sum + qty,
    0,
  )(Array.from(quantities.values()));
  if (totalQuantity === 0) {
    return errorResponse("Please select at least one ticket");
  }

  const selectedEventIds = new Set(quantities.keys());
  const activeQuestions = ctx.questions.filter((q) => {
    const eventIds = ctx.questionEventMap.get(q.id);
    return !eventIds || eventIds.some((eid) => selectedEventIds.has(eid));
  });
  const answersResult = parseQuestionAnswers(form, activeQuestions);
  if (!answersResult.ok) {
    return ticketFormErrorResponse(ctx)(answersResult.error);
  }

  const contact = extractContact(values);

  let date: string | null = null;
  if (ctx.dates.length > 0) {
    date = validateSubmittedDate(form, ctx.dates);
    if (!date) return errorResponse("Please select a valid date");
  }

  const customPricesResult = parseCustomPrices(form, ctx, quantities);
  if (customPricesResult instanceof Response) return customPricesResult;

  await applyQrTokenOverride(form, ctx, customPricesResult);

  const items = buildRegistrationItems(
    ctx.events,
    quantities,
    customPricesResult,
  );

  const info: AnswerInfo = {
    activeQuestions,
    answerIds: answersResult.answerIds,
    selectedEventIds,
  };

  if (await anyRequiresPayment(items)) {
    return handlePaidPath(request, {
      contact,
      ctx,
      date,
      info,
      items,
      quantities,
    });
  }
  return handleFreePath({ contact, ctx, date, info, quantities });
};

/** Handle POST for ticket registration */
const submitTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withCsrfForm(
    request,
    (message) => errorRedirect(`/ticket/${ctx.slugs.join("+")}`, message),
    (form) => {
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      return processSubmission(request, ctx, form);
    },
  );

/** Handle ticket GET/POST orchestrator */
export const handleTicket = async (
  request: Request,
  actionSlugs: string[],
  activeEvents: TicketEvent[],
  getContext: TicketContextProvider,
  qrPrefill?: TicketCtx["qrPrefill"],
): Promise<Response> => {
  const [sharedCtx] = await Promise.all([
    getContext(activeEvents),
    signCsrfToken(),
  ]);
  const ctx: TicketCtx = {
    baseUrl: getBaseUrl(request),
    events: activeEvents,
    slugs: actionSlugs,
    ...sharedCtx,
    qrPrefill,
  };
  const response =
    request.method === "GET"
      ? ticketResponse(ctx)(applyFlash(request).error)
      : await submitTicket(request, ctx);
  const anyHidden = activeEvents.some((e) => e.event.hidden);
  return applyHiddenNoindex(response, anyHidden);
};

/** Handle ticket page by slugs (multi-event) */
export const handleTicketBySlugs = (
  request: Request,
  slugs: string[],
): Promise<Response> =>
  withActiveEvents(slugs, (activeEvents) =>
    handleTicket(request, slugs, activeEvents, getTicketContext),
  );
