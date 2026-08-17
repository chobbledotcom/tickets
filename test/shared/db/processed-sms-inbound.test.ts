import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#shared/db/client.ts";
import {
  claimProcessedSmsInbound,
  pruneProcessedSmsInboundBefore,
} from "#shared/db/processed-sms-inbound.ts";
import { isoBefore } from "#shared/now.ts";
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
    await pruneProcessedSmsInboundBefore(isoBefore(60 * 60 * 1000));
    expect(await storedCount()).toBe(1);

    await pruneProcessedSmsInboundBefore(new Date().toISOString());
    expect(await storedCount()).toBe(0);
  });
});
