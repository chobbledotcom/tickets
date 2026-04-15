/**
 * Admin attendee merge routes
 */

import { compact } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  decryptAttendeeOrNull,
  decryptAttendees,
  type EventAttendeeRow,
  getAttendeesByTokens,
  updateAttendeePII,
} from "#lib/db/attendees.ts";
import { queryAll, queryOne } from "#lib/db/client.ts";
import { getQuestionsWithEventIds } from "#lib/db/questions.ts";
/* jscpd:ignore-start */
import type { FormParams } from "#lib/form-data.ts";
/* jscpd:ignore-end */
import {
  applyAttendeeMerge,
  bookingKey,
  buildAttendeeMergeDiff,
  validateAttendeeMergeDecision,
} from "#lib/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
  MergeAnswerChoice,
  MergeBookingChoice,
  MergeValueChoice,
} from "#lib/merge/attendee-merge-types.ts";
import type { Attendee } from "#lib/types.ts";
import { requirePrivateKey } from "#routes/admin/utils.ts";
import {
  AUTH_FORM,
  type AuthSession,
  applyFlash,
  errorRedirect,
  getSearchParam,
  htmlResponse,
  orNotFound,
  redirect,
  requireSessionOr,
  withAuth,
} from "#routes/utils.ts";
import { adminMergeAttendeePage } from "#templates/admin/attendees.tsx";

/** Load and decrypt a target attendee by ID for merge operations */
const loadMergeTarget = async (
  session: AuthSession,
  attendeeId: number,
): Promise<Attendee | null> => {
  const pk = await requirePrivateKey(session);
  const raw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  return decryptAttendeeOrNull(raw, pk);
};

/** Look up and decrypt a source attendee by ticket token */
const loadMergeSource = async (
  token: string,
  session: AuthSession,
): Promise<{
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  ticket_token: string;
  bookings: EventAttendeeRow[];
} | null> => {
  const pk = await requirePrivateKey(session);
  const results = await getAttendeesByTokens([token]);
  const raw = results[0];
  if (!raw) return null;
  // Cast to Attendee for decryption — only pii_blob is used by decryptAttendees
  // decryptAttendees always returns the same-length array — safe to index directly
  const decrypted = (
    await decryptAttendees([raw as unknown as Attendee], pk)
  )[0]!;
  return {
    address: decrypted.address,
    bookings: raw.bookings,
    email: decrypted.email,
    id: raw.id,
    name: decrypted.name,
    phone: decrypted.phone,
    special_instructions: decrypted.special_instructions,
    ticket_token: decrypted.ticket_token,
  };
};

/** Load target attendee and call handler, returning 404 if not found */
const withMergeTarget = (
  session: AuthSession,
  attendeeId: number,
  handler: (target: Attendee) => Response | Promise<Response>,
): Promise<Response> =>
  orNotFound(loadMergeTarget(session, attendeeId), handler);

/** Load all event_attendees rows for an attendee */
const loadAttendeeBookings = (
  attendeeId: number,
): Promise<EventAttendeeRow[]> =>
  queryAll<EventAttendeeRow>(
    `SELECT event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM event_attendees WHERE attendee_id = ? ORDER BY start_at, event_id`,
    [attendeeId],
  );

/** Collect unique event IDs from two sets of bookings */
const collectEventIds = (
  targetBookings: EventAttendeeRow[],
  sourceBookings: EventAttendeeRow[],
): number[] => {
  const ids = new Set<number>();
  for (const b of targetBookings) ids.add(b.event_id);
  for (const b of sourceBookings) ids.add(b.event_id);
  return [...ids];
};

/** Parse merge decision form data into AttendeeMergeDecisionInput */
const parseMergeDecisionForm = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): AttendeeMergeDecisionInput => {
  const pii: Record<string, MergeValueChoice> = {};
  for (const field of diff.piiFields) {
    const val = form.getString(`pii_${field.field}`);
    pii[field.field] = val === "source" ? "source" : "target";
  }

  const answers: Record<string, MergeAnswerChoice> = {};
  for (const item of diff.answerItems) {
    if (item.conflict) {
      const val = form.getString(`answer_${item.questionId}`);
      if (val === "source") answers[String(item.questionId)] = "source";
      else if (val === "clear") answers[String(item.questionId)] = "clear";
      else answers[String(item.questionId)] = "target";
    }
  }

  const bookings: Record<string, MergeBookingChoice> = {};
  for (const item of diff.bookingItems) {
    if (item.conflictClass !== "moveable") {
      const key = bookingKey(item.eventId, item.startAt);
      const val = form.getString(`booking_${key}`);
      if (val === "take_source") bookings[key] = "take_source";
      else if (val === "skip_source") bookings[key] = "skip_source";
      else bookings[key] = "keep_target";
    }
  }

  const version = form.getString("merge_version");
  return { answers, bookings, pii, version };
};

/* jscpd:ignore-start — merge handlers share structural patterns with other route handlers */
/** Handle GET /admin/attendees/:attendeeId/merge — analyze + render decisions */
export const handleMergeGet = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withMergeTarget(session, attendeeId, async (target) => {
      const token = getSearchParam(request, "token");
      const flash = applyFlash(request);

      if (!token) {
        return htmlResponse(
          adminMergeAttendeePage(target, null, null, session, flash.error),
        );
      }

      const source = await loadMergeSource(token, session);

      if (!source) {
        return htmlResponse(
          adminMergeAttendeePage(
            target,
            null,
            token,
            session,
            "Ticket token not found",
          ),
        );
      }

      if (source.id === attendeeId) {
        return htmlResponse(
          adminMergeAttendeePage(
            target,
            null,
            token,
            session,
            "Cannot merge an attendee with themselves",
          ),
        );
      }

      // Load target bookings and compute merge diff
      const targetBookings = await loadAttendeeBookings(attendeeId);
      const allEventIds = collectEventIds(targetBookings, source.bookings);
      const { questions } = await getQuestionsWithEventIds(allEventIds);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings: source.bookings,
          sourceId: source.id,
          sourcePii: {
            address: source.address,
            email: source.email,
            name: source.name,
            phone: source.phone,
            special_instructions: source.special_instructions,
          },
          targetBookings,
          targetId: attendeeId,
          targetPii: {
            address: target.address,
            email: target.email,
            name: target.name,
            phone: target.phone,
            special_instructions: target.special_instructions,
          },
        },
        questions,
      );

      return htmlResponse(
        adminMergeAttendeePage(
          target,
          source,
          token,
          session,
          flash.error,
          diff,
        ),
      );
    }),
  );

/** Handle POST /admin/attendees/:attendeeId/merge — validate + apply decisions */
export const handleMergePost = (
  request: Request,
  { attendeeId }: { attendeeId: number },
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withMergeTarget(session, attendeeId, async (target) => {
      const sourceToken = form.getString("source_token");
      if (!sourceToken) {
        return errorRedirect(
          `/admin/attendees/${attendeeId}/merge`,
          "Source token is required",
        );
      }

      const source = await loadMergeSource(sourceToken, session);
      if (!source) {
        return errorRedirect(
          `/admin/attendees/${attendeeId}/merge?token=${encodeURIComponent(sourceToken)}`,
          "Ticket token not found",
        );
      }

      if (source.id === attendeeId) {
        return errorRedirect(
          `/admin/attendees/${attendeeId}/merge`,
          "Cannot merge an attendee with themselves",
        );
      }

      // Rebuild the diff to validate against
      const targetBookings = await loadAttendeeBookings(attendeeId);
      const allEventIds = collectEventIds(targetBookings, source.bookings);
      const { questions } = await getQuestionsWithEventIds(allEventIds);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings: source.bookings,
          sourceId: source.id,
          sourcePii: {
            address: source.address,
            email: source.email,
            name: source.name,
            phone: source.phone,
            special_instructions: source.special_instructions,
          },
          targetBookings,
          targetId: attendeeId,
          targetPii: {
            address: target.address,
            email: target.email,
            name: target.name,
            phone: target.phone,
            special_instructions: target.special_instructions,
          },
        },
        questions,
      );

      const decision = parseMergeDecisionForm(form, diff);
      const validation = validateAttendeeMergeDecision(diff, decision);

      if (!validation.valid) {
        return htmlResponse(
          adminMergeAttendeePage(
            target,
            source,
            sourceToken,
            session,
            validation.errors.join("; "),
            diff,
          ),
        );
      }

      const result = await applyAttendeeMerge({
        decision,
        diff,
        sourceId: source.id,
        sourcePii: {
          address: source.address,
          email: source.email,
          name: source.name,
          phone: source.phone,
          special_instructions: source.special_instructions,
        },
        targetId: attendeeId,
        targetPii: {
          address: target.address,
          email: target.email,
          name: target.name,
          payment_id: target.payment_id,
          phone: target.phone,
          special_instructions: target.special_instructions,
          ticket_token: target.ticket_token,
        },
      });

      // Update target PII based on decisions
      const mergedPiiName =
        decision.pii.name === "source" ? source.name : target.name;
      await updateAttendeePII(attendeeId, {
        address:
          decision.pii.address === "source" ? source.address : target.address,
        email: decision.pii.email === "source" ? source.email : target.email,
        name: decision.pii.name === "source" ? source.name : target.name,
        payment_id: target.payment_id,
        phone: decision.pii.phone === "source" ? source.phone : target.phone,
        special_instructions:
          decision.pii.special_instructions === "source"
            ? source.special_instructions
            : target.special_instructions,
        ticket_token: target.ticket_token,
      });

      // Log structured summary
      const { summary } = result;
      const parts = compact([
        `Attendee '${source.name}' merged into '${mergedPiiName}'`,
        summary.bookingsMoved > 0
          ? `${summary.bookingsMoved} booking(s) moved`
          : null,
        summary.bookingsSkipped > 0
          ? `${summary.bookingsSkipped} booking(s) skipped`
          : null,
        summary.bookingsReplacedTarget > 0
          ? `${summary.bookingsReplacedTarget} booking(s) replaced`
          : null,
        summary.answersTakenFromSource > 0
          ? `${summary.answersTakenFromSource} answer(s) from source`
          : null,
        summary.answersCleared > 0
          ? `${summary.answersCleared} answer(s) cleared`
          : null,
      ]);
      await logActivity(parts.join(". "), target.event_id);

      const flashParts = [`Merged ${source.name} into ${mergedPiiName}`];
      if (summary.bookingsMoved > 0) {
        flashParts.push(`${summary.bookingsMoved} booking(s) moved`);
      }
      if (summary.bookingsSkipped > 0) {
        flashParts.push(`${summary.bookingsSkipped} booking(s) skipped`);
      }

      return redirect(
        `/admin/attendees/${attendeeId}`,
        flashParts.join(". "),
        true,
      );
    }),
  );
/* jscpd:ignore-end */
