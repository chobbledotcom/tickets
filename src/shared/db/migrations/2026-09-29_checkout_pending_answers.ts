import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-29_checkout_pending_answers",
  "Stage a checkout's free-text answers under the hash of its session id so the confirmation email can show them without the owner key",
  {
    indexes: [],
    newTables: ["checkout_pending_answers"],
  },
);
