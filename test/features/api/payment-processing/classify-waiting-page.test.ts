import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { validatePaidSession } from "#routes/api/payment-processing/classify.ts";
import type { SessionValidation } from "#routes/api/webhook-types.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { expectBuyerRefusalWithoutStaffPanel } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import {
  paidSession,
  stubSessionRetrieval,
} from "#test-utils/payment-session.ts";
import {
  createTestEditorSession,
  getTestSession,
  requestAsSession,
} from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** The return URL as the browser lands on it, without or with a reload count. */
const visitReturn = (wait?: string): Request =>
  new Request(
    `http://localhost/payment/success?session_id=cs_unpaid${
      wait === undefined ? "" : `&wait=${wait}`
    }`,
  );

/** The waiting page of a refused check, as a narrow answer. */
const waitingPageOf = async (result: SessionValidation): Promise<string> => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the waiting page");
  expect(result.response.status).toBe(200);
  return await result.response.text();
};

/** The refusal response of a waiting check, narrowed to the same answer. */
const waitingResponseOf = (result: SessionValidation): Response => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the waiting page");
  return result.response;
};

describeWithEnv(
  "a return that lands before the payment is confirmed",
  { db: true },
  () => {
    // The waiting page speaks through debug output, so capture it.
    const debugSpy = useDebugLogSpy();
    const errors = setupErrorSpy();

    const unpaidProvider = (): Promise<Disposable> =>
      stubSessionRetrieval(
        paidSession("cs_unpaid", {
          metadata: webhookMeta({ name: "Still Going" }),
          paymentStatus: "unpaid",
        }),
      );

    test("shows the waiting page instead of an error", async () => {
      await setupStripe();
      using _provider = await unpaidProvider();

      const result = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn()),
      );

      const page = await waitingPageOf(result);
      expect(page).toContain("We have not received your payment yet");
      expect(page).toContain(
        "If you have paid, your ticket will be sent to you by email.",
      );
      expect(page).toContain('href="/payment/success?session_id=cs_unpaid"');
      expect(page).toContain("Check again");
      expect(page).not.toContain("Payment verification failed");
      // A normal provider state is not an outage: a debug line, not an error.
      expect(debugLogged(debugSpy, "not confirmed yet")).toBe(true);
      expect(errors.contains("E_PAYMENT_SESSION")).toBe(false);
    });

    test("reloads itself while the window is open, then stops", async () => {
      await setupStripe();
      using _provider = await unpaidProvider();

      // No request at all — the webhook-free call the page renders, at its
      // first visit, so the reload window opens at zero.
      const bare = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid"),
      );
      const eighth = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn("8")),
      );
      const ninth = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn("9")),
      );
      const atTheLimit = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn("10")),
      );

      // Each reload carries one count up, so a tab left open stops itself.
      // The URL lives in an HTML attribute, so its & reads as &amp;.
      expect(await waitingPageOf(bare)).toContain(
        "url=/payment/success?session_id=cs_unpaid&amp;wait=1",
      );
      expect(await waitingPageOf(eighth)).toContain("&amp;wait=9");
      expect(await waitingPageOf(ninth)).toContain("&amp;wait=10");
      const page = await waitingPageOf(atTheLimit);
      expect(page).not.toContain("http-equiv=");
      expect(page).not.toContain("This page will keep checking for you.");
      expect(page).toContain("Check again");
    });

    test("keeps a forged reload count inside the window", async () => {
      await setupStripe();
      using _provider = await unpaidProvider();

      const forged = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn("banana")),
      );
      const huge = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn("9999")),
      );

      expect(await waitingPageOf(forged)).toContain("&amp;wait=1");
      expect(await waitingPageOf(huge)).not.toContain("http-equiv=");
    });

    test("hands an owner the diagnostics beside the waiting page", async () => {
      await setupStripe();
      using _provider = await unpaidProvider();
      const request = requestAsSession(
        "/payment/success?session_id=cs_unpaid",
        await getTestSession(),
      );

      const result = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", request),
      );

      const page = await waitingPageOf(result);
      expect(page).toContain("Staff diagnostics");
      expect(page).toContain("cs_unpaid");
      // The row markup (label, then value) cannot pass because the session id
      // carries the word, so this reads the status itself, not the id.
      expect(page).toContain("Payment status</strong> unpaid");
      expect(page).toContain("3-D Secure");
    });

    test("keeps the buyer's page free of staff detail", async () => {
      await setupStripe();
      using _provider = await unpaidProvider();

      const result = await runWithPendingWork(() =>
        validatePaidSession("cs_unpaid", visitReturn()),
      );

      await expectBuyerRefusalWithoutStaffPanel(
        waitingResponseOf(result),
        "We have not received your payment yet",
      );
    });

    test("keeps the panel away from a logged-in editor", async () => {
      await setupStripe();
      using _provider = await unpaidProvider();
      const editorCookie = (await createTestEditorSession()).cookie;

      const result = await runWithPendingWork(() =>
        validatePaidSession(
          "cs_unpaid",
          new Request("http://localhost/payment/success", {
            headers: { cookie: editorCookie },
          }),
        ),
      );

      await expectBuyerRefusalWithoutStaffPanel(
        waitingResponseOf(result),
        "We have not received your payment yet",
      );
    });
  },
);
