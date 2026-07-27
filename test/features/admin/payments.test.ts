import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  PAYMENT_TIME,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import {
  createLegacyAttendeePaymentCase,
  createRefundablePaymentCase,
  createRetryingPaymentDecision,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";

const createCase = async () =>
  (await createRefundablePaymentCase()).paymentCase;

const decisionForm = (revision: number, decision = "refund_remaining") => ({
  case_revision: String(revision),
  decision,
  reason: "Checked the full payment record",
});

const completeRefund = (id = "admin-refund") =>
  stub(stripePaymentProvider, "refundCharge", (charge) =>
    Promise.resolve({
      amount: charge.captured,
      refund: {
        ...REFUND_RESOURCE,
        id: `${id}-${charge.id}`,
        parentId: charge.providerReference.id,
      },
      status: "completed" as const,
    }),
  );

const pendingRefund = () =>
  stub(stripePaymentProvider, "refundCharge", (charge) =>
    Promise.resolve({ amount: charge.captured, status: "pending" as const }),
  );

const createSavedRefundDecision = async () => {
  const paymentCase = await createCase();
  const decision = await createRetryingPaymentDecision(
    paymentCase,
    { kind: "refund_remaining" },
    {
      actorId: 1,
      caseRevision: paymentCase.revision,
      decidedAt: PAYMENT_TIME,
      kind: "refund_remaining",
      reason: "Checked the stored payment facts",
    },
  );
  return { decision, paymentCase };
};

const submitDecision = (paymentCase: Awaited<ReturnType<typeof createCase>>) =>
  adminFormPost(
    `/admin/payments/${paymentCase.id}`,
    decisionForm(paymentCase.revision),
  );

const locationPath = (response: Response): string => {
  const location = response.headers.get("location");
  if (location === null) throw new Error("Expected a redirect location");
  return new URL(location, "https://tickets.test").pathname;
};

const flashCookie = (response: Response): string => {
  const cookie = response.headers.get("set-cookie");
  if (cookie === null) throw new Error("Expected a flash cookie");
  return decodeURIComponent(cookie);
};

describeWithEnv("admin payment cases", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("lists action cases for the owner", async () => {
    const paymentCase = await createCase();

    const response = await adminGet("/admin/payments");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`href="/admin/payments/${paymentCase.id}"`);
    expect(html).toContain("Only part of the payment has been refunded.");
  });

  test("renders safe facts and an unselected required decision", async () => {
    const paymentCase = await createCase();

    const response = await adminGet(`/admin/payments/${paymentCase.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Choose a decision");
    expect(html).toContain('name="decision"');
    expect(html).toContain('value=""');
    expect(html).not.toMatch(/<option[^>]+selected/u);
    expect(html).toContain("<td>£10</td>");
    expect(html).not.toContain(SESSION_RESOURCE.id);
    expect(html).not.toContain("enc:1:");
    expect(html).not.toContain("HMAC");
  });

  test("returns 404 for a missing payment case", async () => {
    expect((await adminGet("/admin/payments/999999")).status).toBe(404);
  });

  test("rejects a form with no decision", async () => {
    const paymentCase = await createCase();

    const { response } = await adminFormPost(
      `/admin/payments/${paymentCase.id}`,
      {
        case_revision: String(paymentCase.revision),
        reason: "Checked the payment",
      },
    );

    expect(response.status).toBe(302);
    expect(locationPath(response)).toBe(`/admin/payments/${paymentCase.id}`);
    expect(flashCookie(response)).toContain("Choose a decision to continue.");
    expect(flashCookie(response)).toContain('"t":"e"');
  });

  test("carries out a valid decision and returns to the case list", async () => {
    const paymentCase = await createCase();
    using provider = completeRefund();

    const { response } = await submitDecision(paymentCase);

    expect(response.status).toBe(302);
    expect(locationPath(response)).toBe("/admin/payments");
    expect(flashCookie(response)).toContain("Payment case resolved.");
    expect(flashCookie(response)).toContain('"t":"s"');
    expect(provider.calls).toHaveLength(2);
  });

  test("returns to a case while its payment work is pending", async () => {
    const paymentCase = await createCase();
    using _provider = pendingRefund();

    const { response } = await submitDecision(paymentCase);
    const pendingPage = await adminGet(`/admin/payments/${paymentCase.id}`);
    const html = await pendingPage.text();

    expect(response.status).toBe(302);
    expect(locationPath(response)).toBe(`/admin/payments/${paymentCase.id}`);
    expect(html).toContain("The saved decision is due after");
    expect(html).not.toContain('name="decision"');
    expect(html).not.toContain("Save and carry out decision");
    expect(html).not.toContain("Retry saved decision");
  });

  test("rejects a decision for an older case revision", async () => {
    const target = await createRefundablePaymentCase();
    if (target.payment.session === null) {
      throw new Error("Expected a payment session");
    }
    await recordPaymentCase(
      {
        evidence: target.payment.bookingIntent,
        nextReconcileAt: null,
        paymentId: target.payment.id,
        reason: "partial_refund",
        resource: target.payment.session,
        state: "needs_action",
      },
      PAYMENT_TIME + 1,
    );

    const { response } = await adminFormPost(
      `/admin/payments/${target.paymentCase.id}`,
      decisionForm(target.paymentCase.revision),
    );

    expect(response.status).toBe(302);
    expect(locationPath(response)).toBe(
      `/admin/payments/${target.paymentCase.id}`,
    );
    expect(flashCookie(response)).toContain(
      "This case changed before your decision was saved.",
    );
    expect(flashCookie(response)).toContain('"t":"e"');
  });

  test("reviews again when the shown payment account changes", async () => {
    settings.setForTest({
      square_access_token: "square-token",
      square_location_id: "location-one",
      square_sandbox: true,
    });
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-account-change",
    );
    const page = await adminGet(`/admin/payments/${paymentCase.id}`);
    const html = await page.text();
    const decision = html.match(
      /value="(assign_provider:square:test:[^"]+)"/u,
    )?.[1];
    if (decision === undefined) throw new Error("Expected a Square choice");
    settings.setForTest({ square_location_id: "location-two" });
    using provider = stub(squareApi, "readPayment", () => {
      throw new Error("A changed account must not read the payment");
    });

    const { response } = await adminFormPost(
      `/admin/payments/${paymentCase.id}`,
      decisionForm(paymentCase.revision, decision),
    );

    expect(locationPath(response)).toBe(`/admin/payments/${paymentCase.id}`);
    expect(flashCookie(response)).toContain(
      "This case changed before your decision was saved. Review the latest facts and choose again.",
    );
    expect(provider.calls).toHaveLength(0);
    expect(await getPaymentCaseDecisions(paymentCase.id)).toEqual([]);
  });

  test("lets an unexpected payment failure reach the error boundary", async () => {
    const paymentCase = await createCase();
    using _provider = stub(stripePaymentProvider, "refundCharge", () => {
      throw new Error("Unexpected provider failure");
    });

    await expect(
      adminFormPost(
        `/admin/payments/${paymentCase.id}`,
        decisionForm(paymentCase.revision),
      ),
    ).rejects.toThrow("failed: Unexpected provider failure");
  });

  test("retries a saved decision and returns to the list when complete", async () => {
    const { decision, paymentCase } = await createSavedRefundDecision();
    using _provider = completeRefund("admin-retry");

    const { response } = await adminFormPost(
      `/admin/payments/${paymentCase.id}/retry/${decision.id}`,
    );

    expect(response.status).toBe(302);
    expect(locationPath(response)).toBe("/admin/payments");
  });

  test("returns to the case when a saved retry stays pending", async () => {
    const { decision, paymentCase } = await createSavedRefundDecision();
    using _provider = pendingRefund();

    const { response } = await adminFormPost(
      `/admin/payments/${paymentCase.id}/retry/${decision.id}`,
    );

    expect(response.status).toBe(302);
    expect(locationPath(response)).toBe(`/admin/payments/${paymentCase.id}`);
  });

  test("hides navigation and routes from a manager", async () => {
    const paymentCase = await createCase();
    const cookie = await createTestManagerSession(
      "manager-payment-session",
      "paymentmanager",
    );

    const [home, list, detail] = await Promise.all([
      awaitTestRequest("/admin/", { cookie }),
      awaitTestRequest("/admin/payments", { cookie }),
      awaitTestRequest(`/admin/payments/${paymentCase.id}`, { cookie }),
    ]);

    expect(await home.text()).not.toContain("/admin/payments");
    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
  });
});
