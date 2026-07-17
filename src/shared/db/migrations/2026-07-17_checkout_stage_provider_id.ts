import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-17_checkout_stage_provider_id",
  "Store the provider checkout id for staged checkouts.",
  { columns: { checkout_stages: ["provider_checkout_id"] } },
);
