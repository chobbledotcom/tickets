import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { staffPaymentDiagnostics } from "#routes/api/payment-processing/staff-diagnostics.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestEditorSession,
  getTestSession,
  requestAsSession,
} from "#test-utils/session.ts";

describeWithEnv(
  "building the owner's payment diagnostics",
  { db: true },
  () => {
    test("hands an owner every known fact and the known reasons", async () => {
      const request = await requestAsSession(
        "/payment/success",
        await getTestSession(),
      );

      const panel = await staffPaymentDiagnostics(request, {
        provider: "sumup",
        sessionId: "cs_84",
        status: "unpaid",
      });

      expect(panel?.rows).toEqual([
        { label: "Provider", value: "sumup" },
        { label: "Session id", value: "cs_84" },
        { label: "Payment status", value: "unpaid" },
      ]);
      expect(panel?.reasons.length).toBe(4);
      expect(
        panel?.reasons.some((reason) => reason.includes("3-D Secure")),
      ).toBe(true);
    });

    test("carries only the facts the branch knew", async () => {
      const { getTestSession } = await import("#test-utils/session.ts");
      const request = await requestAsSession(
        "/payment/success",
        await getTestSession(),
      );

      const panel = await staffPaymentDiagnostics(request, {
        sessionId: "cs_only",
      });

      expect(panel?.rows).toEqual([{ label: "Session id", value: "cs_only" }]);
      expect(panel?.reasons.length).toBe(4);
    });

    test("gives an anonymous reader nothing", async () => {
      const panel = await staffPaymentDiagnostics(
        new Request("http://localhost/payment/success"),
        { sessionId: "cs_84" },
      );

      expect(panel).toBeUndefined();
    });

    test("gives a non-owner nothing", async () => {
      const { cookie } = await createTestEditorSession();
      const request = new Request("http://localhost/payment/success", {
        headers: { cookie },
      });

      const panel = await staffPaymentDiagnostics(request, {
        sessionId: "cs_84",
      });

      expect(panel).toBeUndefined();
    });

    test("gives a caller without a request nothing", async () => {
      const panel = await staffPaymentDiagnostics(undefined, {
        sessionId: "cs_84",
      });

      expect(panel).toBeUndefined();
    });
  },
);
