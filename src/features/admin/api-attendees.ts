/**
 * POST /api/admin/attendees — create a booking through the admin JSON API.
 *
 * The create mirrors the manual-add form. It can overbook. A line can carry
 * an agreed per-unit `price`. The body can record `payments`, named
 * `adjustments`, and the buyer's `answers`. The ledger posts every leg at
 * creation. It never emails the buyer. The attendee rows, lines, ledger legs,
 * answers, and external link commit together. A caller `ticketToken` or an
 * external id makes a retried create a no-op.
 */

import { logActivity } from "#db/activity-log.ts";
import type {
  CreateAttendeeResult,
  ListingBooking,
} from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import type { AttendeeCreationWork } from "#db/attendees/create-batch.ts";
import {
  PENDING_NOTIFICATION,
  type PendingNotificationFlag,
} from "#db/attendees/notification-flags.ts";
import { decryptAttendeeFields } from "#db/attendees/pii.ts";
import { getAttendeeRawByToken } from "#db/attendees/queries.ts";
import { linkNewAttendee } from "#db/external-sources/attendee-link.ts";
import type { TextAnswer } from "#db/question-types.ts";
import { recordAttendeeAnswersSql } from "#db/questions/attendee-answers/at-booking.ts";
import {
  type AttendeeAnswerSet,
  bindPreparedSaveToAttendee,
  prepareAttendeeAnswerSave,
  saveAttendeeAnswersTx,
} from "#db/questions/attendee-answers/save.ts";
import { settings } from "#db/settings.ts";
import { byId } from "#fp";
import { emailPendingForAdminLines } from "#routes/admin/attendees-route-helpers.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { createdBookingEntries } from "#shared/booking.ts";
import {
  apiCreateLedgerPoster,
  type CreateAdjustment,
  remainingBalanceOf,
  taxableChargeAmounts,
} from "#shared/checkout-complete.ts";
import { listPriceOrder, type PricedOrder } from "#shared/checkout-pricing.ts";
import { ATTENDEE_FEATURE_KEYS } from "#shared/records/attendee-answer-keys.ts";
import { withoutHiddenKeys } from "#shared/records/write-access.ts";
import { answerParsed } from "#shared/rest/crud-parsers.ts";
import { featureOffResponse } from "#shared/rest/resource-feature.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { queueManualAddWebhooks } from "#shared/webhook/delivery.ts";
import type { Attendee } from "#types";
import {
  type ApiExternalLink,
  holderOfExternalLink,
} from "./api-attendees-external.ts";
import {
  type ApiAnswer,
  type ApiLine,
  lineListingIds,
  type ParsedApiCreate,
  parseCreateBody,
} from "./api-attendees-parse.ts";
import { logLinkActivity } from "./api-external-sources.ts";

/** One attendee booking row as the admin API answers with it: the decrypted
 * roster row minus the sealed PII blob and its blind index. Storage details go
 * the same way slug_index goes from listing responses. */
export type AdminApiAttendee = Omit<
  Attendee,
  "parent_listing_id" | "pii_blob" | "ticket_token_index"
>;

/** One attendee as the API answers with it. The answer leaves out the
 *  sealed fields, and each key whose feature is off. */
export const toApiAttendee = ({
  parent_listing_id: ___,
  pii_blob: _,
  ticket_token_index: __,
  ...attendee
}: Attendee): Record<string, unknown> =>
  withoutHiddenKeys(ATTENDEE_FEATURE_KEYS, attendee);

/** The owed-email flag a hand-added attendee starts with. It goes up (orange)
 * when a booked line's listing collects an email, because the API create
 * never sends the email itself. Every API line is a booked line. */
const emailPendingFor = (lines: ApiLine[]): PendingNotificationFlag =>
  emailPendingForAdminLines(
    lines.map((line) => ({
      fields: line.listing.fields,
      isBooked: true,
    })),
  );

/** The gross ledger order for an API-created booking. Every line is at the
 *  listing's list price unless the caller agreed a per-unit price for it. It
 *  carries no extras. The taxable adjustments join the tax basis. The other
 *  receipts (payments, adjustments) ride the poster. */
const toLedgerOrder = (
  lines: ApiLine[],
  adjustments: CreateAdjustment[],
): PricedOrder =>
  listPriceOrder(
    lines.map((line) => ({
      listing: line.listing,
      quantity: line.quantity,
      ...(line.price === undefined ? {} : { unitPrice: line.price }),
    })),
    settings.tax,
    taxableChargeAmounts(adjustments),
  );

/** The parsed answers reduced to the shape the answer save prepares: the
 *  chosen option ids and the free-text answers. A choice entry's question is
 *  implied by its answer. The question ids ride on the free-text entries. */
export const toAnswerSet = (answers: ApiAnswer[]): AttendeeAnswerSet => {
  const answerIds: number[] = [];
  const textAnswers: TextAnswer[] = [];
  for (const answer of answers) {
    if ("answerId" in answer) answerIds.push(answer.answerId);
    else
      textAnswers.push({
        questionId: answer.questionId,
        text: answer.freeText,
      });
  }
  return { answerIds, textAnswers };
};

/** The answer write for one created attendee rides the create transaction.
 *  It runs the answer save, then the answers-at-booking record. A failing
 *  answers write rolls the booking back. The save is prepared before the
 *  transaction opens and bound onto the attendee id the insert just made.
 *  An answerless body skips the save. The record still runs: the public
 *  checkout records the questions a booking was asked even when the buyer
 *  answered none. */
const answersCreationWork = async (
  answers: ApiAnswer[],
  listingIds: number[],
): Promise<AttendeeCreationWork> => {
  const prepared = await prepareAttendeeAnswerSave(
    new Map(answers.length === 0 ? [] : [[0, toAnswerSet(answers)]]),
  );
  return async (tx, attendeeId) => {
    await saveAttendeeAnswersTx(
      tx,
      bindPreparedSaveToAttendee(prepared, attendeeId),
      [recordAttendeeAnswersSql(attendeeId, listingIds)],
    );
  };
};

/** The answer for an attendee that already exists, as the API reads it now. */
const existingAttendeeResponse = async (
  existing: Attendee,
): Promise<Response> =>
  jsonResponse({
    attendee: toApiAttendee(
      await decryptAttendeeFields(existing, await requireRequestPrivateKey()),
    ),
  });

/** The answer for a retried create, or null when the create is new. A caller
 *  token and an external id each name the attendee. An external id that
 *  another kind of record holds is a refusal. The unique ticket_token_index
 *  and the guarded link insert are the backstop for a race. Two concurrent
 *  creates can both see the retry keys as fresh. */
const retriedAttendeeResponse = async ({
  externalLink,
  ticketToken,
}: ParsedApiCreate): Promise<Response | null> => {
  if (ticketToken !== undefined) {
    const byToken = await getAttendeeRawByToken(ticketToken);
    if (byToken !== null) return existingAttendeeResponse(byToken);
  }
  if (externalLink === undefined) return null;
  const holder = await holderOfExternalLink(externalLink);
  if (holder.kind === "attendee") {
    return existingAttendeeResponse(holder.attendee);
  }
  return holder.kind === "refused"
    ? apiErrorResponse(holder.refusal.message, holder.refusal.status)
    : null;
};

/** The link write for one created attendee. It rides the create transaction,
 *  so a failing link rolls the booking back. A body with no external source
 *  adds no work. */
const linkCreationWork =
  (externalLink: ApiExternalLink | undefined): AttendeeCreationWork =>
  async (tx, attendeeId) => {
    if (externalLink === undefined) return;
    await linkNewAttendee(
      tx,
      externalLink.source.id,
      externalLink.externalId,
      attendeeId,
    );
  };

/** Run the atomic create for a validated body and answer with the attendee.
 *  A concurrent create under the same caller token or external id can win
 *  between the fresh-key check and the insert. The unique token index or the
 *  guarded link insert then refuses the loser, whose idempotent answer is the
 *  booking the winner stored. Any other failure is re-raised. */
const createFromParsed = async (parsed: ParsedApiCreate): Promise<Response> => {
  const {
    adjustments,
    created,
    lines,
    notifications,
    payments,
    statusId,
    ticketToken,
  } = parsed;
  const { externalLink } = parsed;
  const bookings: ListingBooking[] = lines.map((line) => ({
    date: line.date,
    ...(line.date === null ? {} : { durationDays: line.durationDays }),
    listingId: line.listing.id,
    quantity: line.quantity,
  }));
  const order = toLedgerOrder(lines, adjustments);
  const receipts = { adjustments, payments };
  // Admin manual add can deliberately overbook (a warning shows, the system
  // does not block). The poster records the sale and VAT legs at the lines'
  // prices plus the payment and adjustment legs in the same create
  // transaction. The input carries the projected net as remainingBalance, so
  // the attendee owes the lines and charges minus what was paid or written
  // off. The net includes the tax, because the sale total is tax-inclusive.
  // The order total already holds the taxable adjustments and their tax.
  const remainingBalance = remainingBalanceOf(order, receipts);
  // The answers are encrypted and blind-indexed before the transaction opens.
  // The write itself rides the create work below. An answerless body prepares
  // no save but still records the questions the booking was asked.
  const answerWork = await answersCreationWork(
    parsed.answers,
    lineListingIds(lines),
  );
  const linkWork = linkCreationWork(externalLink);
  const creationWork: AttendeeCreationWork = async (tx, attendeeId) => {
    await apiCreateLedgerPoster(order, receipts)(tx, attendeeId);
    await answerWork(tx, attendeeId);
    await linkWork(tx, attendeeId);
  };
  let result: CreateAttendeeResult;
  try {
    result = await attendeesApi.createAttendeeAtomic(
      {
        address: parsed.address,
        allowOverbook: true,
        bookings,
        email: parsed.email,
        emailPending: notifications
          ? emailPendingFor(lines)
          : PENDING_NOTIFICATION.none,
        name: parsed.name,
        phone: parsed.phone,
        remainingBalance,
        source: "admin",
        special_instructions: parsed.special_instructions,
        statusId,
        ...(ticketToken === undefined ? {} : { ticketToken }),
        ...(created === undefined ? {} : { created }),
      },
      creationWork,
    );
  } catch (error) {
    const retried = await retriedAttendeeResponse(parsed);
    if (retried !== null) return retried;
    throw error;
  }
  if (!result.success) {
    return apiErrorResponse("The booking could not be created");
  }
  const attendee = result.attendees[0]!;
  const listingsById = byId(lines.map((line) => line.listing));
  // Notification behaviour matches a manual admin add: the buyer email waits
  // for the admin page's Re-send action, and the listings' webhooks fire. An
  // imported booking (notifications: false) sends no webhook and owes no
  // email, so neither flag is left up.
  if (notifications) {
    queueManualAddWebhooks(
      createdBookingEntries(result.attendees, listingsById),
    );
  }
  await logActivity(
    `Attendee '${parsed.name}' added via API`,
    lines[0]!.listing.id,
    attendee.id,
  );
  if (externalLink !== undefined) {
    await logLinkActivity(
      "added to",
      externalLink.externalId,
      externalLink.source,
    );
  }
  return jsonResponse({ attendee: toApiAttendee(attendee) }, 201);
};

/** Handle POST /api/admin/attendees. Staff-only, matching the dashboard's
 *  attendee create surface (areas-a-l.ts "attendees"). */
export const handleCreateAttendee: RouteHandlerFn = (request) =>
  withAuth(request, ADMIN_API, async (_session, body) =>
    answerParsed(parseCreateBody(body), async (parsedValue) => {
      if (
        parsedValue.externalLink !== undefined &&
        !settings.features.externalSources
      ) {
        return featureOffResponse("externalSources");
      }
      // A caller token or external id makes a retry a no-op. The booking
      // exists under it, so nothing is written. The existing attendee is
      // returned.
      const retried = await retriedAttendeeResponse(parsedValue);
      return retried ?? createFromParsed(parsedValue);
    }),
  );
