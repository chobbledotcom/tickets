import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-23_payment_refund_attempts",
  "Keep non-idempotent refund submissions from being sent twice.",
  { newTables: ["payment_refund_attempts"] },
);
