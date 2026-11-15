import { afterEach, beforeEach } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import {
  sql,
  sqlCommas,
  sqlJoin,
  sqlLiteral,
  sqlName,
  sqlNames,
} from "#db/sql.ts";
import { paymentModel } from "#scripts/verify-models/model.ts";

/** Record guard facts at each real write. Later cleanup cannot erase a violation. */
export const observePaymentSeam = async (): Promise<() => Promise<void>> => {
  const model = await paymentModel();
  const sameRequest = sqlJoin(
    ["capability", "generation", "identityIndex", "replayUntil"].map(
      (field) => {
        const path = sqlLiteral(`$.request.${field}`);
        return sql`json_extract(OLD.refund_state, ${path}) IS
      json_extract(NEW.refund_state, ${path})`;
      },
    ),
    sql` AND `,
  );
  const claimLegal = sql`NEW.payment_reference_index != ''`;
  const rules = [
    {
      columns: ["refund_state"],
      identity: sqlName("NEW.reference_index"),
      legal: {
        INSERT: sql`0`,
        UPDATE: sql`NEW.refund_state_name = 'send_armed'
          AND NEW.reference_index != ''
          AND NEW.reference_index = OLD.reference_index
          AND NEW.refund_revision = OLD.refund_revision + 1
          AND ${sameRequest}`,
      },
      name: "send",
      table: "payment_charges",
      when: sql`NEW.refund_state_name IN (${sqlCommas(model.sendAuthorityNames.map(sqlLiteral))})`,
    },
    {
      columns: ["protected_state", "payment_reference_index"],
      identity: sqlName("NEW.payment_session_id"),
      legal: { INSERT: claimLegal, UPDATE: claimLegal },
      name: "claim",
      table: "processed_payments",
      when: sql`NEW.protected_state = ${sqlLiteral(model.claimMirror)}`,
    },
  ];
  await execute(sql`CREATE TABLE test_payment_edges (
    edge TEXT NOT NULL, identity TEXT NOT NULL, guard_ok INTEGER NOT NULL
  )`);
  const triggers: string[] = [];
  for (const rule of rules) {
    for (const event of ["INSERT", "UPDATE"] as const) {
      const name = `test_payment_edge_${triggers.length}`;
      const operation =
        event === "INSERT"
          ? sql`INSERT`
          : sql`UPDATE OF ${sqlNames(rule.columns)}`;
      await execute(sql`CREATE TRIGGER ${sqlName(name)}
        AFTER ${operation} ON ${sqlName(rule.table)}
        WHEN ${rule.when}
        BEGIN
          INSERT INTO test_payment_edges (edge, identity, guard_ok)
          SELECT ${sqlLiteral(rule.name)}, ${rule.identity}, ${rule.legal[event]};
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
      }>(sql`SELECT edge, identity, guard_ok FROM test_payment_edges`);
      for (const edge of edges) {
        if (edge.guard_ok !== 1) {
          throw new Error(
            `Payment ${edge.edge} guard failed for ${edge.identity}`,
          );
        }
      }
    } finally {
      for (const name of triggers)
        await execute(sql`DROP TRIGGER ${sqlName(name)}`);
      await execute(sql`DROP TABLE test_payment_edges`);
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
