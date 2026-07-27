import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-26_payment_history_redaction",
  "Mark terminal payment payloads and resolved case evidence after privacy redaction.",
  {
    columns: {
      payment_cases: ["evidence_redacted_at"],
      payment_sessions: ["redacted_at"],
    },
    indexes: ["idx_payment_cases_redaction", "idx_payment_sessions_redaction"],
  },
);
