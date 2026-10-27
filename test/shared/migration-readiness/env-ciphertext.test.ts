/**
 * Tests for the env-key ciphertext verification over the processed-payment
 * rows: non-empty `ticket_tokens` must decrypt, non-empty `failure_data` must
 * decrypt and parse as a terminal outcome — what the replay path does.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { EMPTY_ROW_STATE, writeRowState } from "#payment/row-state.ts";
import { withOutcome } from "#payment/row-transitions.ts";
import { envCiphertextFailures } from "#shared/migration-readiness/env-ciphertext.ts";
import {
  envEnc,
  processed,
} from "#test/shared/migration-readiness/fixtures.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

const FAILURE_CONTEXT = "processed_payments.failure_data";

/** The failure_data bytes production writes for a handled terminal failure. */
const storedTerminalOutcome = async (): Promise<EnvKeyEncrypted> =>
  await encrypt(
    writeRowState(
      withOutcome(EMPTY_ROW_STATE, { error: "sold out", refunded: true }),
      FAILURE_CONTEXT,
    ),
  );

/** A row with every encrypted field filled and valid. */
const verifiedRow = async (
  sessionId: string,
): Promise<ReturnType<typeof processed>> =>
  processed({
    attendee_id: null,
    failure_data: await storedTerminalOutcome(),
    payment_session_id: sessionId,
    ticket_tokens: await encrypt("tok1+tok2"),
  });

describe("migration-readiness env ciphertext verification", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  test("reports no failures when every encrypted field decrypts", async () => {
    const failures = await envCiphertextFailures([await verifiedRow("s1")]);
    expect(failures.undecryptableFailureData).toEqual(new Set());
    expect(failures.undecryptableTicketTokens).toEqual(new Set());
  });

  test("skips rows whose encrypted fields are empty", async () => {
    const failures = await envCiphertextFailures([processed({})]);
    expect(failures.undecryptableFailureData).toEqual(new Set());
    expect(failures.undecryptableTicketTokens).toEqual(new Set());
  });

  test("reports a ticket_tokens value that does not decrypt", async () => {
    const failures = await envCiphertextFailures([
      processed({
        payment_session_id: "bad-tokens",
        ticket_tokens: envEnc("corrupt"),
      }),
    ]);
    expect(failures.undecryptableTicketTokens).toEqual(new Set(["bad-tokens"]));
    expect(failures.undecryptableFailureData).toEqual(new Set());
  });

  test("reports failure_data that does not decrypt", async () => {
    const failures = await envCiphertextFailures([
      processed({
        attendee_id: null,
        failure_data: envEnc("corrupt"),
        payment_session_id: "bad-failure",
      }),
    ]);
    expect(failures.undecryptableFailureData).toEqual(new Set(["bad-failure"]));
    expect(failures.undecryptableTicketTokens).toEqual(new Set());
  });

  test("reports failure_data that decrypts but is not row state", async () => {
    const failures = await envCiphertextFailures([
      processed({
        attendee_id: null,
        failure_data: await encrypt("not json"),
        payment_session_id: "unparsable-failure",
      }),
    ]);
    expect(failures.undecryptableFailureData).toEqual(
      new Set(["unparsable-failure"]),
    );
  });

  test("reports failure_data that parses but holds no terminal outcome", async () => {
    const failures = await envCiphertextFailures([
      processed({
        attendee_id: null,
        failure_data: await encrypt(
          writeRowState(EMPTY_ROW_STATE, FAILURE_CONTEXT),
        ),
        payment_session_id: "outcomeless-failure",
      }),
    ]);
    expect(failures.undecryptableFailureData).toEqual(
      new Set(["outcomeless-failure"]),
    );
  });

  test("collects each failing session once across many rows", async () => {
    const failures = await envCiphertextFailures([
      await verifiedRow("good"),
      processed({
        payment_session_id: "bad-tokens",
        ticket_tokens: envEnc("corrupt"),
      }),
      processed({
        attendee_id: null,
        failure_data: envEnc("corrupt"),
        payment_session_id: "bad-failure",
      }),
      processed({
        payment_session_id: "also-bad-tokens",
        ticket_tokens: envEnc("corrupt"),
      }),
    ]);
    expect(failures.undecryptableTicketTokens).toEqual(
      new Set(["bad-tokens", "also-bad-tokens"]),
    );
    expect(failures.undecryptableFailureData).toEqual(new Set(["bad-failure"]));
  });
});
