/**
 * Core ticket submission orchestrator
 */

import { reduce } from "#fp";
import { countAssignableSites } from "#lib/db/built-sites.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { saveEventAnswers } from "#lib/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#lib/demo.ts";
import { isPaidEvent } from "#lib/types.ts";
import {
  applyFlash,
  errorRedirect,
  getBaseUrl,
  redirectResponse,
  withCsrfForm,
} from "#routes/utils.ts";
import { tryValidateTicketFields } from "#templates/fields.ts";
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

/** Sum quantity needed across events with assign_built_site enabled */
const totalSitesNeeded = (
  events: TicketEvent[],
  quantities: Map<number, number>,
): number => {
  let total = 0;
  for (const { event } of events) {
    if (event.assign_built_site) {
      total += quantities.get(event.id) ?? 0;
    }
  }
  return total;
};

/** Handle POST for ticket registration */
const submitTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withCsrfForm(
    request,
    (message) => errorRedirect(`/ticket/${ctx.slugs.join("+")}`, message),
    async (form) => {
      const { dates, terms } = ctx;

      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);

      // Validate fields based on merged event settings
      const errorResponse = ticketFormErrorResponse(ctx);
      const anyPaid = ctx.events.some((e) => isPaidEvent(e.event));
      const fieldResult = tryValidateTicketFields(
        form,
        getTicketFieldsSetting(ctx.events),
        errorResponse,
        anyPaid,
      );
      if (fieldResult instanceof Response) return fieldResult;
      const values = fieldResult;

      // Validate terms and conditions acceptance if configured
      if (terms && form.get("agree_terms") !== "1") {
        return errorResponse("You must agree to the terms and conditions");
      }

      // Re-check registration status: events may have closed or sold out
      // since the form was rendered
      const allUnavailable = ctx.events.every((e) => e.isSoldOut || e.isClosed);
      if (allUnavailable) {
        const allClosed = ctx.events.every((e) => e.isClosed);
        return ticketFormErrorResponse(ctx)(
          allClosed
            ? REGISTRATION_CLOSED_SUBMIT_MESSAGE
            : "Sorry, not enough spots available",
        );
      }

      // Check if any event the user selected is now closed
      for (const { event, isClosed } of ctx.events) {
        const selectedQty = Number.parseInt(
          form.get(`quantity_${event.id}`) || "0",
          10,
        );
        if (isClosed && selectedQty > 0) {
          return ticketFormErrorResponse(ctx)(
            REGISTRATION_CLOSED_SUBMIT_MESSAGE,
          );
        }
      }

      // Parse quantities
      const quantities = parseQuantities(form, ctx.events);

      // Check at least one ticket selected
      const totalQuantity = reduce(
        (sum: number, qty: number) => sum + qty,
        0,
      )(Array.from(quantities.values()));
      if (totalQuantity === 0) {
        return ticketFormErrorResponse(ctx)(
          "Please select at least one ticket",
        );
      }

      // Validate custom question answers (only for selected events)
      const selectedEventIds = new Set(quantities.keys());
      const activeQuestions = ctx.questions.filter((q) => {
        const eventIds = ctx.questionEventMap.get(q.id);
        return !eventIds || eventIds.some((eid) => selectedEventIds.has(eid));
      });
      const answersResult = parseQuestionAnswers(form, activeQuestions);
      if (!answersResult.ok) {
        return errorResponse(answersResult.error);
      }

      const contact = extractContact(values);

      // For daily events, validate the submitted date
      let date: string | null = null;
      if (dates.length > 0) {
        date = validateSubmittedDate(form, dates);
        if (!date) {
          return ticketFormErrorResponse(ctx)("Please select a valid date");
        }
      }

      // Parse custom prices for pay-more events
      const customPrices = new Map<number, number>();
      for (const { event } of ctx.events) {
        if (event.can_pay_more) {
          const qty = quantities.get(event.id) ?? 0;
          if (qty > 0) {
            const priceResult = parseCustomPrice(
              form,
              `custom_price_${event.id}`,
              event.unit_price,
              event.max_price,
            );
            if (!priceResult.ok) {
              return ticketFormErrorResponse(ctx)(
                `${event.name}: ${priceResult.error}`,
              );
            }
            customPrices.set(event.id, priceResult.price);
          }
        }
      }

      // Build registration items
      const items = buildRegistrationItems(
        ctx.events,
        quantities,
        customPrices,
      );

      // Check built site availability for assign_built_site events
      // Only runs when the builder feature is enabled
      const sitesNeeded = totalSitesNeeded(ctx.events, quantities);
      if (sitesNeeded > 0 && isBuilderEnabled()) {
        const availableSites = await countAssignableSites();
        if (availableSites < sitesNeeded) {
          return ticketFormErrorResponse(ctx)(
            "Sorry, not enough sites available",
          );
        }
      }

      // Check if payment required
      if (await anyRequiresPayment(items)) {
        const available = await checkAvailability(ctx.events, quantities, date);
        if (!available) {
          return ticketFormErrorResponse(ctx)(
            "Sorry, some tickets are no longer available",
          );
        }

        const eventAnswerIds =
          answersResult.answerIds.length > 0
            ? buildEventAnswerMap(
                activeQuestions,
                answersResult.answerIds,
                ctx.questionEventMap,
                selectedEventIds,
              )
            : undefined;
        const intent = {
          ...contact,
          date,
          items,
          eventAnswerIds,
        };
        return handlePaymentFlow(request, intent, ctx);
      }

      // Free registration
      const result = await processFreeReservation(
        ctx.events,
        quantities,
        contact,
        date,
      );

      if (!result.success) {
        return ticketFormErrorResponse(ctx)(result.error);
      }

      // Save per-event answers for each attendee
      if (answersResult.answerIds.length > 0) {
        const eventAnswerMap = buildEventAnswerMap(
          activeQuestions,
          answersResult.answerIds,
          ctx.questionEventMap,
          selectedEventIds,
        );
        await saveEventAnswers(result.entries, eventAnswerMap);
      }

      // For single-event bookings, respect the event's custom thank-you URL
      if (ctx.events.length === 1) {
        const thankYouUrl = ctx.events[0]!.event.thank_you_url;
        if (thankYouUrl) return redirectResponse(thankYouUrl);
      }

      const token = encodeURIComponent(result.token);
      return redirectResponse(`/ticket/reserved?tokens=${token}`);
    },
  );

/** Handle ticket GET/POST orchestrator */
export const handleTicket = async (
  request: Request,
  actionSlugs: string[],
  activeEvents: TicketEvent[],
  getContext: TicketContextProvider,
): Promise<Response> => {
  const [sharedCtx] = await Promise.all([
    getContext(activeEvents),
    signCsrfToken(),
  ]);
  const ctx: TicketCtx = {
    slugs: actionSlugs,
    events: activeEvents,
    baseUrl: getBaseUrl(request),
    ...sharedCtx,
  };
  if (request.method === "GET") applyFlash(request);
  const response =
    request.method === "GET"
      ? ticketResponse(ctx)()
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
