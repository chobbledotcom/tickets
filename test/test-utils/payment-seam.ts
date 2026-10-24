import { afterEach, beforeEach } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import { paymentModel } from "#scripts/verify-models/model.ts";

/** Record guard facts at each real write. Later cleanup cannot erase a violation. */
export const observePaymentSeam = async (): Promise<() => Promise<void>> => {
  const model = await paymentModel();
  const sqlWord = (word: string): string => `'${word.replaceAll("'", "''")}'`;
  const sameRequest = [
    "capability",
    "generation",
    "identityIndex",
    "replayUntil",
  ]
    .map(
      (field) => `json_extract(OLD.refund_state, '$.request.${field}') IS
      json_extract(NEW.refund_state, '$.request.${field}')`,
    )
    .join(" AND ");
  const claimLegal = "NEW.payment_reference_index != ''";
  const rules = [
    {
      column: "refund_state",
      identity: "NEW.reference_index",
      legal: {
        INSERT: "0",
        UPDATE: `NEW.refund_state_name = 'send_armed'
          AND NEW.reference_index != ''
          AND NEW.reference_index = OLD.reference_index
          AND NEW.refund_revision = OLD.refund_revision + 1
          AND ${sameRequest}`,
      },
      name: "send",
      table: "payment_charges",
      when: `NEW.refund_state_name IN (${model.sendAuthorityNames.map(sqlWord).join(", ")})`,
    },
    {
      column: "protected_state, payment_reference_index",
      identity: "NEW.payment_session_id",
      legal: { INSERT: claimLegal, UPDATE: claimLegal },
      name: "claim",
      table: "processed_payments",
      when: `NEW.protected_state = ${sqlWord(model.claimMirror)}`,
    },
  ];
  await execute(`CREATE TABLE test_payment_edges (
    edge TEXT NOT NULL, identity TEXT NOT NULL, guard_ok INTEGER NOT NULL
  )`);
  const triggers: string[] = [];
  for (const rule of rules) {
    for (const event of ["INSERT", "UPDATE"] as const) {
      const name = `test_payment_edge_${triggers.length}`;
      const operation =
        event === "INSERT" ? event : `${event} OF ${rule.column}`;
      await execute(`CREATE TRIGGER ${name}
        AFTER ${operation} ON ${rule.table}
        WHEN ${rule.when}
        BEGIN
          INSERT INTO test_payment_edges (edge, identity, guard_ok)
          SELECT ${sqlWord(rule.name)}, ${rule.identity}, ${rule.legal[event]};
        END`);
      triggers.push(name);
    }
  }
  return async () => {
    try {
      const edges = await queryAll<{
        edge: string;
        identity: string;
        guard_ok: number;
      }>("SELECT edge, identity, guard_ok FROM test_payment_edges");
      for (const edge of edges) {
        if (edge.guard_ok !== 1) {
          throw new Error(
            `Payment ${edge.edge} guard failed for ${edge.identity}`,
          );
        }
      }
    } finally {
      for (const name of triggers) await execute(`DROP TRIGGER ${name}`);
      await execute("DROP TABLE test_payment_edges");
    }
  };
};

/** Register only inside a database suite, after its database setup hook. */
export const checkPaymentSeam = (): void => {
  let verify: () => Promise<void>;
  beforeEach(async () => {
    verify = await observePaymentSeam();
  });
  afterEach(async () => {
    await verify();
  });
};
