import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-18_checkout_stage_refund_spec",
  "Keep the original reason while a checkout refund is still processing.",
  { columns: { checkout_stages: ["refund_spec"] } },
);
