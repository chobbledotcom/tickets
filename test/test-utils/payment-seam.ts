import { afterEach, beforeEach } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import { paymentModel } from "#scripts/verify-models/model.ts";

/** Record guard facts at each real write. Later cleanup cannot erase a violation. */
export const observePaymentSeam = async (): Promise<() => Promise<void>> => {
  const model = await paymentModel();
  const sqlWord = (word: string): string => `'${word.replaceAll("'", "''")}'`;
  const claim = sqlWord(model.claimMirror);
  const rules = [
    {
      column: "refund_state",
      identity: "NEW.reference_index",
      legal: `EXISTS (
        SELECT 1 FROM processed_payments AS payment
         WHERE payment.payment_reference_index = NEW.reference_index
           AND payment.protected_state = ${claim}
      )`,
      name: "send",
      table: "payment_charges",
      when: `NEW.refund_state_name IN (${model.sendAuthorityNames.map(sqlWord).join(", ")})`,
    },
    {
      column: "protected_state",
      identity: "NEW.payment_session_id",
      legal: "NEW.payment_reference_index != ''",
      name: "claim",
      table: "processed_payments",
      when: `NEW.protected_state = ${claim}`,
    },
  ];
  await execute(`CREATE TABLE test_payment_edges (
    edge TEXT NOT NULL, identity TEXT NOT NULL, guard_held INTEGER NOT NULL
  )`);
  const triggers: string[] = [];
  for (const rule of rules) {
    for (const event of ["INSERT", `UPDATE OF ${rule.column}`]) {
      const name = `test_payment_edge_${triggers.length}`;
      await execute(`CREATE TRIGGER ${name}
        AFTER ${event} ON ${rule.table}
        WHEN ${rule.when}
        BEGIN
          INSERT INTO test_payment_edges (edge, identity, guard_held)
          SELECT ${sqlWord(rule.name)}, ${rule.identity}, ${rule.legal};
        END`);
      triggers.push(name);
    }
  }
  return async () => {
    try {
      const edges = await queryAll<{
        edge: string;
        identity: string;
        guard_held: number;
      }>("SELECT edge, identity, guard_held FROM test_payment_edges");
      for (const edge of edges) {
        if (edge.guard_held !== 1) {
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
