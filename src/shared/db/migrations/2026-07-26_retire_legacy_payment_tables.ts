import { schemaMigration } from "./define.ts";
import {
  assertLegacyPaymentSourcesDrained,
  blockLegacyPaymentWrites,
  dropLegacyPaymentSources,
  existingLegacyPaymentTables,
} from "./legacy-payment-retirement.ts";
import { LEGACY_PAYMENT_TABLE_NAMES } from "./legacy-payment-schema.ts";

export default schemaMigration(
  "2026-07-26_retire_legacy_payment_tables",
  "Remove drained payment staging tables after the durable payment copy.",
  { absentTables: LEGACY_PAYMENT_TABLE_NAMES },
  async ({ getDb }) => {
    const existing = await existingLegacyPaymentTables(getDb);
    await blockLegacyPaymentWrites(getDb, existing);
    await assertLegacyPaymentSourcesDrained(getDb, existing);
    await dropLegacyPaymentSources(getDb);
  },
);
