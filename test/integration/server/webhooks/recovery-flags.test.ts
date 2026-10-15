import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute } from "#db/client.ts";
import {
  runWebhook,
  setupRenewalSite,
  stubLostCreate,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { readPendingNotificationFlags } from "#test-utils/db-helpers/attendees.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";

describeWithEnv("paid booking lost-result recovery flags", { db: true }, () => {
  const fetchSpy = stubFetchEachTest(() => new Response());

  test("the recovery's queued sends own the pending flags they clear", async () => {
    // The lost create raised both flags and never sent; the recovery
    // replays the sends and owns their flags. An accepted replay clears
    // both, a refused replay leaves both up for the admin, and the
    // finalized session's send-free replay changes nothing.
    await configureTestEmail();
    const { edgeSecretCalls, listing, tokenIndex } = await setupRenewalSite(
      "Recovery Flags Site",
      "recovery-flags.b-cdn.net",
    );
    await execute("UPDATE listings SET webhook_url = ? WHERE id = ?", [
      await encrypt("https://registration.example.com/hook"),
      listing.id,
    ]);
    const metadata = signMeta(
      webhookMeta({
        email: "recovery.flags@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Flag Recovery",
        phone: "+447700900999",
        site_token_index: tokenIndex,
      }),
      1000,
    );
    const loseResult = stubLostCreate();
    const runLostWebhook = async (id: string): Promise<void> => {
      await runWebhook({ amount_total: 1000, id, metadata }, async () => {
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(true);
        });
      });
    };
    try {
      await runLostWebhook("cs_recovery_flags");
      const [attendee] = await getAttendeesRaw(listing.id);
      expect(await readPendingNotificationFlags(attendee!.id)).toEqual({
        email: 0,
        webhooks: 0,
      });

      // The refused replay of a second lost create leaves both flags up.
      fetchSpy.reply(() => new Response("", { status: 500 }));
      await runLostWebhook("cs_recovery_flags_refused");
      // The listing's attendee rows read newest first; the second booking's
      // attendee is the one the accepted phase did not already read.
      const refusedAttendee = (await getAttendeesRaw(listing.id)).find(
        (one) => one.id !== attendee!.id,
      )!;
      expect(await readPendingNotificationFlags(refusedAttendee.id)).toEqual({
        email: 1,
        webhooks: 1,
      });

      // The finalized session's send-free replay changes nothing.
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        ["cs_recovery_flags"],
      );
      await runLostWebhook("cs_recovery_flags");
      expect(await readPendingNotificationFlags(attendee!.id)).toEqual({
        email: 0,
        webhooks: 0,
      });
    } finally {
      edgeSecretCalls.restore();
      loseResult.restore();
    }
  });
});
