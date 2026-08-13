import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-08-13_refund_authority",
  "Turn the unwritten payment_charges table into the one durable refund authority, with owner-only references, globally unique charge and callback identities, and explicit state mirrors",
  async ({ getDb, recreateTable }) => {
    const existing = await getDb().execute(
      "SELECT 1 FROM payment_charges LIMIT 1",
    );
    if (existing.rows.length > 0) {
      throw new Error(
        "payment_charges is not empty; refusing to reinterpret stored payment " +
          "history as refund-authority state",
      );
    }
    await recreateTable("payment_charges");
  },
);
