import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import {
  claimProcessedSmsInbound,
  pruneProcessedSmsInboundBefore,
} from "#db/processed-sms-inbound.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const storedCount = async (): Promise<number> => {
  const row = await queryOne<{ total: number }>(
    "SELECT COUNT(*) AS total FROM processed_sms_inbound",
  );
  return Number(row?.total ?? 0);
};

describeWithEnv("db > processed sms inbound", { db: true }, () => {
  test("claims a webhook id once and refuses its replay", async () => {
    expect(await claimProcessedSmsInbound("wh_once")).toBe(true);
    expect(await claimProcessedSmsInbound("wh_once")).toBe(false);
    expect(await storedCount()).toBe(1);
  });

  test("treats an empty webhook id as processed without storing it", async () => {
    expect(await claimProcessedSmsInbound("")).toBe(true);
    expect(await storedCount()).toBe(0);
  });

  test("prunes only rows older than the cutoff", async () => {
    await claimProcessedSmsInbound("wh_recent");
    // Fixed bounds either side of any possible stamp, so the assertion never
    // depends on the process clock a neighbouring grouped test may control.
    await pruneProcessedSmsInboundBefore("1970-01-01T00:00:00.000Z");
    expect(await storedCount()).toBe(1);

    await pruneProcessedSmsInboundBefore("9999-12-31T23:59:59.999Z");
    expect(await storedCount()).toBe(0);
  });
});
