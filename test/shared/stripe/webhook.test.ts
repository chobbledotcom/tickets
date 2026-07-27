import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  type StripeWebhookEvent,
  verifyWebhookSignature,
} from "#shared/stripe/webhook.ts";
import {
  signedHeader,
  signedWebhook,
} from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import { activateStripe } from "#test-utils/settings.ts";

describeStripe("stripe", () => {
  test("logs when the webhook secret is missing", async () => {
    const errorSpy = spy(console, "error");
    try {
      const result = await verifyWebhookSignature("{}", "t=1,v1=abc");
      expect(result).toEqual({
        error: "Webhook secret not configured",
        valid: false,
      });
      expect(errorSpy.calls[0]?.args[0]).toContain(
        'E_CONFIG_MISSING detail="webhook secret"',
      );
    } finally {
      errorSpy.restore();
    }
  });

  describe("verifyWebhookSignature - timestamp parsing", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_timestamp_test";
    const expectInvalidHeader = async (
      payload: string,
      signature: string,
      reason: string,
    ): Promise<void> => {
      const errorSpy = spy(console, "error");
      try {
        expect(await verifyWebhookSignature(payload, signature)).toEqual({
          error: "Invalid signature header format",
          valid: false,
        });
        expect(errorSpy.calls).toHaveLength(1);
        expect(errorSpy.calls[0]!.args[0]).toContain(
          `detail="invalid header: ${reason}"`,
        );
      } finally {
        errorSpy.restore();
      }
    };

    test("accepts a generated event timestamp", async () => {
      await activateStripe(TEST_SECRET, "we_test_ts");

      // Create listing with proper signature
      const listing: StripeWebhookEvent = {
        data: { object: { id: "cs_test" } },
        id: "evt_ts_test",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await signedWebhook(listing, TEST_SECRET);

      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
    });

    test("accepts a decimal timestamp in the header", async () => {
      await activateStripe(TEST_SECRET, "we_test_parse");

      const payload = '{"id": "evt_parse", "type": "test"}';
      const result = await verifyWebhookSignature(
        payload,
        await signedHeader(TEST_SECRET, payload),
      );
      expect(result.valid).toBe(true);
    });

    test("rejects a timestamp key without a value", async () => {
      await activateStripe(TEST_SECRET, "we_test_nullish");
      await expectInvalidHeader(
        '{"test": true}',
        "t,v1=abc123",
        "missing timestamp",
      );
    });

    test("rejects a signature key without a value", async () => {
      await activateStripe(TEST_SECRET, "we_test_signature_without_value");
      await expectInvalidHeader("{}", "t=123,v1", "missing signature");
    });

    test("ignores a bare signature key", async () => {
      await activateStripe(TEST_SECRET, "we_test_bare_signature");
      await expectInvalidHeader("{}", "v1", "missing timestamp and signature");
    });

    test("parses timestamps as decimal numbers", async () => {
      await activateStripe(TEST_SECRET, "we_test_decimal");
      const result = await verifyWebhookSignature("{}", "t=0x10,v1=abc");
      expect(result).toEqual({
        error: "Invalid signature header format",
        valid: false,
      });
    });

    test("rejects a signed timestamp with a suffix", async () => {
      await activateStripe(TEST_SECRET, "we_test_timestamp_suffix");
      const payload = "{}";
      const signed = await signedHeader(TEST_SECRET, payload);
      await expectInvalidHeader(
        payload,
        signed.replace(",", "junk,"),
        "invalid timestamp",
      );
    });

    test("rejects a signed timestamp with an extra delimiter", async () => {
      await activateStripe(TEST_SECRET, "we_test_timestamp_delimiter");
      const payload = "{}";
      const signed = await signedHeader(TEST_SECRET, payload);
      await expectInvalidHeader(
        payload,
        signed.replace(",", "=junk,"),
        "invalid timestamp",
      );
    });

    test("rejects a signature with an extra delimiter", async () => {
      await activateStripe(TEST_SECRET, "we_test_signature_delimiter");
      const payload = "{}";
      const signed = await signedHeader(TEST_SECRET, payload);
      await expectInvalidHeader(payload, `${signed}=junk`, "invalid signature");
    });

    test("rejects a timestamp outside the safe integer range", async () => {
      await activateStripe(TEST_SECRET, "we_test_unsafe_timestamp");
      await expectInvalidHeader(
        "{}",
        "t=9007199254740992,v1=abc",
        "invalid timestamp",
      );
    });

    test("rejects a zero timestamp", async () => {
      await activateStripe(TEST_SECRET, "we_test_zero_timestamp");
      await expectInvalidHeader("{}", "t=0,v1=abc", "invalid timestamp");
    });

    test("uses the last timestamp in the header", async () => {
      await activateStripe(TEST_SECRET, "we_test_last_timestamp");
      const payload = "{}";
      const signed = await signedHeader(TEST_SECRET, payload);
      const result = await verifyWebhookSignature(payload, `t=1,${signed}`);
      expect(result.valid).toBe(true);
    });

    test("accepts the first of multiple v1 signatures", async () => {
      await activateStripe(TEST_SECRET, "we_test_first_signature");
      using _time = new FakeTime(1_700_000_000_000);
      const payload = "{}";
      const signed = await signedHeader(TEST_SECRET, payload, 1_700_000_000);
      const result = await verifyWebhookSignature(
        payload,
        `${signed},v1=wrong`,
      );
      expect(result.valid).toBe(true);
    });

    test("accepts the second of multiple v1 signatures", async () => {
      await activateStripe(TEST_SECRET, "we_test_second_signature");
      using _time = new FakeTime(1_700_000_000_000);
      const payload = "{}";
      const signed = await signedHeader(TEST_SECRET, payload, 1_700_000_000);
      const result = await verifyWebhookSignature(
        payload,
        signed.replace("v1=", "v1=wrong,v1="),
      );
      expect(result.valid).toBe(true);
    });

    for (const [delta, valid] of [
      [-301, false],
      [-300, true],
      [300, true],
      [301, false],
    ] as const) {
      test(`${delta >= 0 ? "+" : ""}${delta} seconds is ${valid ? "inside" : "outside"} the tolerance`, async () => {
        await activateStripe(TEST_SECRET, `we_test_tolerance_${delta}`);
        using _time = new FakeTime(1_700_000_000_000);
        const payload = "{}";
        const timestamp = 1_700_000_000 + delta;
        const signature = await signedHeader(TEST_SECRET, payload, timestamp);
        expect((await verifyWebhookSignature(payload, signature)).valid).toBe(
          valid,
        );
      });
    }

    test("secureCompare handles strings of different lengths", async () => {
      await activateStripe(TEST_SECRET, "we_test_len");

      // Provide a signature that has different length than expected
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await verifyWebhookSignature(
        '{"test": true}',
        `t=${timestamp},v1=short`,
      );
      // Signature won't match but should not crash - secureCompare handles length diff
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });
  });

  describe("verifyWebhookSignature - enhanced error details", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_detail_tests";

    beforeEach(async () => {
      await activateStripe(TEST_SECRET, "we_test_details");
    });

    test("logs 'missing timestamp' when header has signature but no timestamp", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "v1=abc123");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid header: missing timestamp"');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs 'missing signature' when header has timestamp but no v1", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "t=1234");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid header: missing signature"');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs 'missing timestamp and signature' for completely invalid header", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "invalid-header");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain(
          'detail="invalid header: missing timestamp and signature"',
        );
      } finally {
        errorSpy.restore();
      }
    });

    test("logs timestamp delta and tolerance when out of tolerance", async () => {
      const errorSpy = spy(console, "error");
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400;
      const payload = '{"test": true}';
      const header = await signedHeader(TEST_SECRET, payload, oldTimestamp);

      try {
        const result = await verifyWebhookSignature(payload, header);
        expect(result).toEqual({
          error: "Timestamp outside tolerance window",
          valid: false,
        });
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain("timestamp out of tolerance delta=");
        expect(callArg).toContain("tolerance=300s");
      } finally {
        errorSpy.restore();
      }
    });

    test("logs JSON parse error message for invalid payload", async () => {
      const errorSpy = spy(console, "error");
      const payload = "not valid json {{{";
      const header = await signedHeader(TEST_SECRET, payload);

      try {
        await verifyWebhookSignature(payload, header);
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid JSON:');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs a signature mismatch", async () => {
      const errorSpy = spy(console, "error");
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const result = await verifyWebhookSignature(
          "{}",
          `t=${timestamp},v1=wrong`,
        );
        expect(result).toEqual({
          error: "Signature verification failed",
          valid: false,
        });
        expect(errorSpy.calls[0]?.args[0]).toContain(
          'E_STRIPE_SIGNATURE detail="mismatch"',
        );
      } finally {
        errorSpy.restore();
      }
    });
  });
});
