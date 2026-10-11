/**
 * The maintenance write gate. The operator's flag refuses every write outside
 * the exempt tables, so an update's migrations run without concurrent writes,
 * and the migration runner opens its own window for the batch — whatever the
 * batch's outcome.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { restampRefundLegs } from "#accounting/reverses-group.ts";
import { postTransfers } from "#accounting/store.ts";
import { getDb } from "#db/client.ts";
import gateMigration from "#db/migrations/2026-10-11_maintenance_write_gate.ts";
import {
  closeMigrationWindow,
  openMigrationWindow,
} from "#db/migrations/gate.ts";
import { runPendingMigrations } from "#db/migrations/runner.ts";
import {
  GATE_EXEMPT_TABLES,
  MAINTENANCE_GATE_TRIGGER_NAMES,
} from "#db/migrations/schema/gate-triggers.ts";
import { SCHEMA } from "#db/migrations/schema/index.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import type { Migration } from "#db/migrations/types.ts";
import { settings } from "#db/settings.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { defineMaintenanceTasks } from "#shared/maintenance/definition.ts";
import { maintenance } from "#shared/maintenance/runner.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import {
  expectStampedToBooking,
  refundGroupOfBooking,
  seedUnattributedRefund,
  stampedReversesOf,
} from "#test/shared/accounting/reverses-group/helpers.ts";
import { maintenanceDeclaration } from "#test/shared/maintenance/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import { tx } from "#test-utils/transfer-factory.ts";

const rawGateValue = async (): Promise<string> => {
  const rows = await getDb().execute({
    args: [CONFIG_KEYS.MAINTENANCE_GATE],
    sql: "SELECT value FROM settings WHERE key = ?",
  });
  return String(rows.rows[0]?.value ?? "");
};

const setRawGate = (value: string): Promise<unknown> =>
  getDb().execute({
    args: [value, CONFIG_KEYS.MAINTENANCE_GATE],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  });

const storedLeg = (): TransferInput =>
  tx({
    amount: 100,
    destination: attendeeAccount(1),
    eventGroup: "evt-gate-leg",
    kind: KIND.sale,
    reference: "gate-sale",
    source: revenueAccount(7),
  });

describeWithEnv(
  "db > migrations > maintenance write gate",
  { db: true, triggers: true },
  () => {
    test("covers every schema table except the exempt ones", () => {
      const gateTriggers = TRIGGERS.filter(({ name }) =>
        name.includes("maintenance_gate"),
      );

      for (const [name] of SCHEMA) {
        const tableTriggers = gateTriggers.filter(
          ({ table }) => table === name,
        );
        if (GATE_EXEMPT_TABLES.has(name)) {
          expect(
            tableTriggers,
            `exempt table ${name} carries a gate trigger`,
          ).toEqual([]);
          continue;
        }
        expect(
          tableTriggers.map(({ name: triggerName }) => triggerName),
        ).toEqual([
          `trg_${name}_maintenance_gate_insert`,
          `trg_${name}_maintenance_gate_update`,
          `trg_${name}_maintenance_gate_delete`,
        ]);
      }
    });

    test("declares every trigger it owns", () => {
      const context = buildMigrationContext({
        applySchemaChanges,
        syncIndexes,
      });
      expect(gateMigration(context).requires).toEqual({
        triggers: MAINTENANCE_GATE_TRIGGER_NAMES,
      });
      expect(gateMigration(context).id).toBe(
        "2026-10-11_maintenance_write_gate",
      );
    });

    test("refuses ledger writes while engaged and allows them after", async () => {
      await postTransfers([storedLeg()]);

      await settings.update.maintenanceGate(true);
      await expect(
        postAttendeeRefund({
          attendeeId: 1,
          eventId: "gate-refund",
          gross: 500,
          listingId: 7,
        }),
      ).rejects.toThrow("site is in maintenance mode");
      await expect(
        getDb().execute({ args: [], sql: "UPDATE transfers SET memo = 'x'" }),
      ).rejects.toThrow("site is in maintenance mode");
      await expect(
        getDb().execute({ args: [], sql: "DELETE FROM transfers" }),
      ).rejects.toThrow("site is in maintenance mode");

      await settings.update.maintenanceGate(false);
      await getDb().execute({ args: [], sql: "DELETE FROM transfers" });
    });

    test("keeps the operator's own rows writable while engaged", async () => {
      await settings.update.maintenanceGate(true);
      await settings.update.underlineLinks(true);
      expect(settings.underlineLinks).toBe(true);
      await settings.update.underlineLinks(false);
      await settings.update.maintenanceGate(false);
    });

    test("the lift re-stamps a leg that slipped in during the window", async () => {
      // The runner's window is open, so a pre-column writer's reversal lands
      // unstamped; the window then closes with the leg behind the walk's mark.
      await setRawGate("migrating");
      const bookingGroup = await seedUnattributedRefund("gate-straggler", 9);
      await setRawGate("true");
      expect(
        await stampedReversesOf(await refundGroupOfBooking(bookingGroup)),
      ).toEqual(new Set([""]));

      const windowOpen = await openMigrationWindow();
      try {
        await restampRefundLegs();
      } finally {
        if (windowOpen) await closeMigrationWindow();
      }
      await settings.update.maintenanceGate(false);

      await expectStampedToBooking(bookingGroup);
      expect(settings.maintenanceGate).toBe(false);
    });

    test("opens the window for the runner and closes it after the batch", async () => {
      await settings.update.maintenanceGate(true);
      let during = "";
      const migration: Migration = {
        description: "Captures the gate value the batch runs under.",
        id: "test-gate-window",
        up: async () => {
          during = await rawGateValue();
        },
        verify: async () => {},
      };

      await runPendingMigrations([migration], "gate-window-token");

      expect(during).toBe("migrating");
      expect(await rawGateValue()).toBe("true");
      await settings.update.maintenanceGate(false);
    });

    test("closes the window when a migration fails", async () => {
      await settings.update.maintenanceGate(true);
      const migration: Migration = {
        description: "Fails so the window must close on the way out.",
        id: "test-gate-failure",
        up: async () => {
          throw new Error("broken migration");
        },
        verify: async () => {},
      };

      await expect(
        runPendingMigrations([migration], "gate-failure-token"),
      ).rejects.toThrow("broken migration");
      expect(await rawGateValue()).toBe("true");
      await settings.update.maintenanceGate(false);
    });

    test("leaves a non-engaged gate alone", async () => {
      let during = "unset";
      const migration: Migration = {
        description: "Captures the gate value without an engaged gate.",
        id: "test-gate-absent",
        up: async () => {
          during = await rawGateValue();
        },
        verify: async () => {},
      };

      await runPendingMigrations([migration], "gate-absent-token");

      expect(during).toBe("");
      expect(await rawGateValue()).toBe("");
    });

    test("skips maintenance tasks while the gate is engaged", async () => {
      const ran: string[] = [];
      const tasks = defineMaintenanceTasks([
        maintenanceDeclaration("gated", () => {
          ran.push("gated");
        }),
      ]);
      const runDue = async (): Promise<void> => {
        await getDb().execute({
          args: ["gated"],
          sql: "UPDATE maintenance_tasks SET next_run_at = 0 WHERE name = ?",
        });
        await maintenance.run(tasks);
      };

      await settings.update.maintenanceGate(true);
      await runDue();
      expect(ran).toEqual([]);

      await settings.update.maintenanceGate(false);
      await runDue();
      expect(ran).toEqual(["gated"]);
    });
  },
);
