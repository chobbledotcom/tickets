import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { initSentry } from "#shared/sentry.ts";
import { squareApi } from "#shared/square/api.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { gbp } from "#test-utils/payment-state.ts";
import { providerRefundHttpCases } from "#test-utils/provider-failure-cases.ts";
import { resetSentry, sentryRequestBody } from "#test-utils/sentry.ts";
import {
  configureSquare,
  squareRefundRequest,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";
import { squareBoundaryValidationError } from "#test-utils/square/outcomes.ts";

const PRIVATE_REFERENCE = "PRIVATE_REFERENCE";

const request = squareRefundRequest({
  charge: {
    captured: gbp(1000),
    confirmedRefunded: gbp(0),
    refunds: [],
  },
  paymentReference: "pay_failure",
});

const outcomeWhen = async (error: unknown): Promise<RefundAttemptResult> =>
  await withSquareClient(
    { refundsRefundPayment: () => Promise.reject(error) },
    () => squareApi.refundCharge(request),
  );

describeSquare(() => {
  const errors = setupErrorSpy();

  describe("refundCharge failures", () => {
    test("states that no request left when Square is not configured", async () => {
      expect(await squareApi.refundCharge(request)).toEqual({
        kind: "not_sent",
        reason: "not_configured",
      });
    });

    for (const [status, expected] of providerRefundHttpCases) {
      test(`classifies HTTP ${status} without guessing`, async () => {
        expect(
          await outcomeWhen(
            transportError.answered(providerDetail.square(), status),
          ),
        ).toEqual(expected);
      });
    }

    for (const reason of ["network_error", "timeout"] as const) {
      test(`keeps a ${reason} connection failure uncertain`, async () => {
        expect(
          await outcomeWhen(
            transportError.unreachable(providerDetail.square(), reason),
          ),
        ).toEqual({
          kind: "uncertain",
          reason,
        });
      });
    }

    test("names invalid JSON as a malformed response", async () => {
      expect(
        await outcomeWhen(transportError.unusable(providerDetail.square())),
      ).toEqual({
        kind: "uncertain",
        reason: "malformed_response",
      });
    });

    test("names a boundary validation failure as malformed", async () => {
      expect(await outcomeWhen(squareBoundaryValidationError())).toEqual({
        kind: "uncertain",
        reason: "malformed_response",
      });
    });

    test("keeps a provider body out of refund diagnostics", async () => {
      using _env = withEnv({
        NTFY_URL: undefined,
        SENTRY_URL: "https://square@bugs.example.test/2",
      });
      const responseBody = `{ "errors": [{ "detail": "${PRIVATE_REFERENCE}" }] }`;
      using fetchStub = stubFetch((url) =>
        url.includes("squareupsandbox.com")
          ? new Response(responseBody, { status: 503 })
          : new Response("{}", { status: 200 }),
      );

      try {
        await configureSquare({ sandbox: true });
        await initSentry();
        const result = await runWithPendingWork(() =>
          squareApi.refundCharge(request),
        );
        expect(result).toEqual({
          kind: "uncertain",
          reason: "provider_error",
        });

        expect(errors.lastMessage()).toContain("outcome=uncertain");
        expect(errors.lastMessage()).toContain("reason=provider_error");
        expect(errors.lastMessage()).not.toContain(PRIVATE_REFERENCE);

        const body = sentryRequestBody(fetchStub.calls);
        expect(body).not.toContain(PRIVATE_REFERENCE);
        expect(body).toContain("Status code: 503");
        expect(body).toContain("stacktrace");
        expect(body).toContain(
          '"detail":"outcome=uncertain reason=provider_error"',
        );
      } finally {
        resetSentry();
      }
    });

    test("does not relabel an unknown internal failure as a network error", async () => {
      await expect(outcomeWhen(new Error("internal bug"))).rejects.toThrow(
        "internal bug",
      );
      // The refund left with nobody able to say what became of it, so the
      // report names our own failure rather than one of Square's.
      expect(errors.lastMessage()).toContain(
        "outcome=thrown reason=internal_error",
      );
    });
  });
});
