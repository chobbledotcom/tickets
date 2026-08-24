import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assignBuiltSite, insertBuiltSite } from "#db/built-sites.ts";
import { queryAll, queryOne } from "#db/client.ts";
import {
  createMergePair,
  runMerge,
} from "#test/shared/merge/attendee-merge/helpers.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertRefundConfirmationFixture } from "#test-utils/refund-confirmations.ts";

describeWithEnv("attendee merge cleanup", { db: true }, () => {
  test("removes checkout stages for both merged attendees", async () => {
    const { source, target } = await createMergePair();
    await insertCheckoutStage(target.id, "merge-target-stage");
    await insertCheckoutStage(source.id, "merge-source-stage");

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    expect(
      await queryAll<{ attendee_id: number }>(
        "SELECT attendee_id FROM checkout_stages WHERE attendee_id IN (?, ?)",
        [target.id, source.id],
      ),
    ).toEqual([]);
  });

  test("removes source confirmation identities without touching the target", async () => {
    const { source, target } = await createMergePair();
    const sourceConfirmation = await insertRefundConfirmationFixture(source.id);
    const targetConfirmation = await insertRefundConfirmationFixture(target.id);

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    expect(
      await queryAll<{ attendee_id: number }>(
        `SELECT attendee_id
           FROM refund_confirmations AS confirmation
          ORDER BY confirmation.attendee_id`,
      ),
    ).toEqual([{ attendee_id: target.id }]);
    expect(
      await queryAll<{ confirmation_identity: string }>(
        `SELECT confirmation_identity
           FROM refund_confirmation_references AS reference
          ORDER BY confirmation_identity`,
      ),
    ).toEqual([{ confirmation_identity: targetConfirmation.identity }]);
    expect(sourceConfirmation.identity).not.toBe(targetConfirmation.identity);
  });

  test("moves a built-site assignment from the source to the target", async () => {
    const { listing2, source, target } = await createMergePair();
    const site = await insertBuiltSite(
      "Merged attendee site",
      "merged-attendee.example.test",
      "",
      "",
      true,
    );
    await assignBuiltSite(site.id, source.id, listing2.id);

    const { result } = await runMerge({ source, target });

    expect(result.success).toBe(true);
    expect(
      await queryOne<{ assigned_attendee_id: number | null }>(
        "SELECT assigned_attendee_id FROM built_sites WHERE id = ?",
        [site.id],
      ),
    ).toEqual({ assigned_attendee_id: target.id });
  });
});
