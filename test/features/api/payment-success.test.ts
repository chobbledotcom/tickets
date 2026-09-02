import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handlePaymentSuccess } from "#routes/api/payment-success.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { expectBuyerRefusalWithoutStaffPanel } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
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

/** Makes the provider answer every retrieval with this still-unpaid checkout,
 *  the TICKETS-84 shape, for as long as the test runs. */
const unpaidAnswers = (): Promise<Disposable> =>
  stubSessionRetrieval(
    paidSession("cs_route_unpaid", {
      paymentReference: "",
      paymentStatus: "unpaid",
    }),
  );

describeWithEnv("the payment success redirect route", { db: true }, () => {
  test("hands an owner the diagnostics when the checkout is unpaid", async () => {
    await setupStripe();
    using _provider = await unpaidAnswers();

    const response = await runWithPendingWork(async () =>
      handlePaymentSuccess(
        await requestAsSession(
          "/payment/success?session_id=cs_route_unpaid",
          await getTestSession(),
        ),
      ),
    );

    const page = await response.text();
    expect(page).toContain("Staff diagnostics");
    expect(page).toContain("cs_route_unpaid");
    // The row markup (label, then value) cannot pass because the session id
    // carries the word, so this reads the status itself, not the id.
    expect(page).toContain("Payment status</strong> unpaid");
  });

  test("keeps an anonymous buyer's page free of staff detail", async () => {
    await setupStripe();
    using _provider = await unpaidAnswers();

    const response = await handlePaymentSuccess(
      new Request(
        "http://localhost/payment/success?session_id=cs_route_unpaid",
      ),
    );

    await expectBuyerRefusalWithoutStaffPanel(
      response,
      "Payment verification failed. Please contact support.",
    );
  });

  test("keeps the panel away from a logged-in editor", async () => {
    await setupStripe();
    using _provider = await unpaidAnswers();
    const editorCookie = (await createTestEditorSession()).cookie;

    const response = await handlePaymentSuccess(
      new Request(
        "http://localhost/payment/success?session_id=cs_route_unpaid",
        {
          headers: { cookie: editorCookie },
        },
      ),
    );

    await expectBuyerRefusalWithoutStaffPanel(
      response,
      "Payment verification failed. Please contact support.",
    );
  });

  test("names the callback's facts to an owner when nothing readable arrived", async () => {
    await setupStripe();

    const response = await runWithPendingWork(async () =>
      handlePaymentSuccess(
        await requestAsSession("/payment/success", await getTestSession()),
      ),
    );

    const page = await response.text();
    expect(page).toContain("Invalid payment callback");
    expect(page).toContain("Staff diagnostics");
  });
});
