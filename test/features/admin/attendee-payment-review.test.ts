/** Owner-facing payment-review route behavior. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deleteListing } from "#db/listings/delete.ts";
import { getPaymentReviewState } from "#db/payment-review.ts";
import { resetI18nForTest } from "#i18n";
import { handleRequest } from "#routes";
import { nowIso } from "#shared/now.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  parseFlashCookie,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import {
  CLAIM_MIRROR,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
  storedRecordOf,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import {
  createTestManagerSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

/* jscpd:ignore-end */

const ACTION = "payment-review";
const NAME = "Review Person";
const SUCCESS = "Payment review acknowledged";
const NOTHING = "This payment no longer needs review.";
const CLAIMED =
  "A refund for this payment is still in progress. Finish or re-run it before marking the payment reviewed.";

type ReviewContext = {
  attendeeId: number;
  cookie: string;
  csrfToken: string;
  listingId: number;
  sessionId: string;
};

const reviewUrl = (attendeeId: number): string =>
  `/admin/attendees/${attendeeId}/${ACTION}`;

const actionsUrl = (attendeeId: number): string =>
  `/admin/attendees/${attendeeId}/actions`;

const paymentReviewActivity = async (attendeeId: number) =>
  (await getAttendeeActivityLog(attendeeId)).filter(
    ({ message }) => message === "Payment review acknowledged by owner",
  );

const setReview = async (
  sessionId: string,
  caseId = `route-case-${sessionId}`,
): Promise<void> => {
  await putRowState(
    sessionId,
    await rowStateSlot({
      review: reviewCase({ kind: "partially_returned_obligation" }, caseId),
    }),
    REVIEW_MIRROR,
  );
};

const setupReview = async (review = true): Promise<ReviewContext> => {
  const listing = await createTestListing({});
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    NAME,
    "review@example.com",
  );
  const sessionId = `sess-review-route-${attendee.id}`;
  await finalizeProcessedPayment(sessionId, attendee.id);
  if (review) await setReview(sessionId);
  return {
    attendeeId: attendee.id,
    cookie: await testCookie(),
    csrfToken: await testCsrfToken(),
    listingId: listing.id,
    sessionId,
  };
};

const submitReview = async (
  context: ReviewContext,
  values: Record<string, string> = {},
  cookie = context.cookie,
): Promise<Response> => {
  const state = await getPaymentReviewState(context.attendeeId);
  const reviewIdentity = state.status === "needs_review" ? state.identity : "";
  return handleRequest(
    mockFormRequest(
      reviewUrl(context.attendeeId),
      {
        confirm_identifier: NAME,
        csrf_token: context.csrfToken,
        review_identity: reviewIdentity,
        ...values,
      },
      cookie,
    ),
  );
};

describeWithEnv("admin payment review action", { db: true }, () => {
  describe("GET confirmation", () => {
    test("asks the owner to type the attendee name and keeps the return URL", async () => {
      const context = await setupReview();
      const returnUrl = `${actionsUrl(context.attendeeId)}#payment`;
      const response = await awaitTestRequest(
        `${reviewUrl(context.attendeeId)}?return_url=${encodeURIComponent(
          returnUrl,
        )}`,
        { cookie: context.cookie },
      );

      await expectHtmlResponse(
        response,
        200,
        "Mark payment reviewed",
        NAME,
        "type their name",
        "The safety hold stays in place",
        "does not contact the provider or change money.",
        'name="review_identity"',
        'name="return_url"',
        returnUrl,
      );
    });

    test("rejects managers before loading payment-review work", async () => {
      const context = await setupReview();
      const manager = await createTestManagerSession(
        "payment-review-manager-get",
        "payment-review-manager-get",
      );

      expect(
        (
          await awaitTestRequest(reviewUrl(context.attendeeId), {
            cookie: manager,
          })
        ).status,
      ).toBe(403);
    });

    test("renders an accurate error when no review work remains", async () => {
      const context = await setupReview(false);
      const response = await awaitTestRequest(reviewUrl(context.attendeeId), {
        cookie: context.cookie,
      });

      await expectHtmlResponse(response, 400, NOTHING);
    });

    test("translates guard errors inside the current request", async () => {
      const context = await setupReview(false);
      using _env = withEnv({ I18N_REPLACEMENTS: "review|inspection" });
      resetI18nForTest();
      try {
        const response = await awaitTestRequest(reviewUrl(context.attendeeId), {
          cookie: context.cookie,
        });

        await expectHtmlResponse(
          response,
          400,
          "This payment no longer needs inspection.",
        );
      } finally {
        resetI18nForTest();
      }
    });
  });

  describe("POST confirmation", () => {
    test("requires a valid CSRF token", async () => {
      const context = await setupReview();
      const before = await storedRecordOf(context.sessionId);

      expect(
        (await submitReview(context, { csrf_token: "not-valid" })).status,
      ).toBe(403);
      expect(await storedRecordOf(context.sessionId)).toBe(before);
    });

    test("requires the exact attendee name", async () => {
      const context = await setupReview();
      const before = await storedRecordOf(context.sessionId);

      await expectFlashRedirect(
        reviewUrl(context.attendeeId),
        "Attendee name does not match. Please type the exact attendee name to confirm payment review.",
        false,
      )(
        await submitReview(context, {
          confirm_identifier: "Somebody Else",
        }),
      );
      expect(await storedRecordOf(context.sessionId)).toBe(before);
    });

    test("uses trusted attendee and listing context and honors return_url", async () => {
      const context = await setupReview();
      const returnUrl = `/admin/attendees/${context.attendeeId}/activity`;

      await expectFlashRedirect(
        returnUrl,
        SUCCESS,
      )(
        await submitReview(context, {
          attendee_id: "999999",
          listing_id: "999999",
          return_url: returnUrl,
        }),
      );

      expect(await protectedStateOf(context.sessionId)).toBe(REVIEW_MIRROR);
      expect(await storedRecordOf(context.sessionId)).not.toBe("");
      expect(await getPaymentReviewState(context.attendeeId)).toMatchObject({
        allAcknowledged: true,
        status: "needs_review",
      });
      expect(await paymentReviewActivity(context.attendeeId)).toEqual([
        expect.objectContaining({
          attendee_id: context.attendeeId,
          listing_id: context.listingId,
          message: "Payment review acknowledged by owner",
        }),
      ]);
    });

    test("acknowledges an orphan attendee without inventing a listing", async () => {
      const context = await setupReview();
      await deleteListing(context.listingId);

      await expectFlashRedirect(
        actionsUrl(context.attendeeId),
        SUCCESS,
      )(await submitReview(context));
      expect(await paymentReviewActivity(context.attendeeId)).toEqual([
        expect.objectContaining({
          attendee_id: context.attendeeId,
          listing_id: null,
        }),
      ]);
    });

    test("treats a concurrent replay as already current and logs nothing", async () => {
      const context = await setupReview(false);
      const response = await submitReview(context);

      expectRedirect(response, actionsUrl(context.attendeeId));
      const flash = parseFlashCookie(response);
      expect(flash.info).toBe(NOTHING);
      expect(flash.formToken).toBeUndefined();
      expect(await paymentReviewActivity(context.attendeeId)).toEqual([]);
    });

    test("treats acknowledgement replay as current and logs only once", async () => {
      const context = await setupReview();
      await submitReview(context);
      const replay = await submitReview(context);

      expectRedirect(replay, actionsUrl(context.attendeeId));
      expect(parseFlashCookie(replay).info).toBe(
        "This payment review was already acknowledged.",
      );
      expect(await paymentReviewActivity(context.attendeeId)).toHaveLength(1);
      expect(await protectedStateOf(context.sessionId)).toBe(REVIEW_MIRROR);
    });

    test("rejects a stale form after a newer review case opens", async () => {
      const context = await setupReview();
      const first = await getPaymentReviewState(context.attendeeId);
      if (first.status !== "needs_review")
        throw new Error("review was omitted");
      await setReview(context.sessionId, "new-route-case");

      await expectFlashRedirect(
        reviewUrl(context.attendeeId),
        "The payment review changed. Check the current details and confirm again.",
        false,
      )(await submitReview(context, { review_identity: first.identity }));
      expect(await paymentReviewActivity(context.attendeeId)).toEqual([]);
    });

    test("keeps an in-progress claim and review for a later retry", async () => {
      const context = await setupReview(false);
      await putRowState(
        context.sessionId,
        await rowStateSlot({
          claim: {
            attendeeIds: [context.attendeeId],
            commandId: "test-review-command",
            phase: "checking",
            scope: "attendee_set",
            writtenAt: nowIso(),
          },
          review: reviewCase({ kind: "partially_returned_obligation" }),
        }),
        CLAIM_MIRROR,
      );
      const returnUrl = actionsUrl(context.attendeeId);

      await expectHtmlResponse(
        await awaitTestRequest(reviewUrl(context.attendeeId), {
          cookie: context.cookie,
        }),
        400,
        CLAIMED,
      );

      await expectFlashRedirect(
        `${reviewUrl(context.attendeeId)}?return_url=${encodeURIComponent(
          returnUrl,
        )}`,
        CLAIMED,
        false,
      )(await submitReview(context, { return_url: returnUrl }));
      expect(await protectedStateOf(context.sessionId)).toBe(CLAIM_MIRROR);
      expect(await paymentReviewActivity(context.attendeeId)).toEqual([]);
    });

    test("managers receive 403 and cannot acknowledge the review", async () => {
      const context = await setupReview();
      const before = await storedRecordOf(context.sessionId);
      const manager = await createTestManagerSession(
        "payment-review-manager-post",
        "payment-review-manager-post",
      );

      expect((await submitReview(context, {}, manager)).status).toBe(403);
      expect(await storedRecordOf(context.sessionId)).toBe(before);
      expect(await paymentReviewActivity(context.attendeeId)).toEqual([]);
    });
  });
});
