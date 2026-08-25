import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ErrorCode } from "#shared/logger.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import { finishWebhookVerification } from "#shared/webhook-verification.ts";

const PAYLOAD = '{"data":{"object":{"id":"evt_1"}},"id":"evt_1","type":"paid"}';

const finish = (matched: boolean, payload: string) =>
  finishWebhookVerification(matched, payload, ErrorCode.STRIPE_SIGNATURE);

describe("finishWebhookVerification", () => {
  test("refuses a payload whose signature did not match", () => {
    expect(finish(false, PAYLOAD)).toEqual({
      error: "Signature verification failed",
      valid: false,
    });
  });

  test("does not read the body of a payload it refused", () => {
    expect(finish(false, "not JSON at all")).toEqual({
      error: "Signature verification failed",
      valid: false,
    });
  });

  test("reads a signed body as the event itself", () => {
    expect(finish(true, PAYLOAD)).toEqual({
      listing: {
        data: { object: { id: "evt_1" } },
        id: "evt_1",
        type: "paid",
      } satisfies WebhookEvent,
      valid: true,
    });
  });

  test("refuses a signed payload that is not JSON", () => {
    expect(finish(true, "{not json")).toEqual({
      error: "Invalid JSON payload",
      valid: false,
    });
  });
});
