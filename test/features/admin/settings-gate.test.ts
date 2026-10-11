/** The maintenance gate route: engaging it, lifting it, and the lift's
 *  re-stamp of a refund leg that slipped in during a migration window. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleMaintenanceGatePost } from "#routes/admin/settings-general.ts";
import {
  expectStampedToBooking,
  seedUnattributedRefund,
} from "#test/shared/accounting/reverses-group/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

const postGate = async (value: string | undefined): Promise<Response> =>
  handleMaintenanceGatePost(
    mockFormRequest(
      "/admin/settings/maintenance-gate",
      {
        ...(value === undefined ? {} : { maintenance_gate: value }),
        csrf_token: await testCsrfToken(),
      },
      await testCookie(),
    ),
  );

describeWithEnv(
  "admin settings > maintenance gate",
  { db: true, triggers: true },
  () => {
    test("engaging the gate stores it", async () => {
      const response = await postGate("true");

      expect(response.status).toBe(302);
      expect(settings.maintenanceGate).toBe(true);
    });

    test("lifting the gate stamps a leg the window let in, then lifts", async () => {
      const bookingGroup = await seedUnattributedRefund("evt-gate-lift", 1);
      await settings.update.maintenanceGate(true);

      const response = await postGate(undefined);

      expect(response.status).toBe(302);
      await expectStampedToBooking(bookingGroup);
      expect(settings.maintenanceGate).toBe(false);
    });

    test("lifting with the gate not engaged still stamps and stays off", async () => {
      const bookingGroup = await seedUnattributedRefund("evt-gate-plain", 1);

      const response = await postGate(undefined);

      expect(response.status).toBe(302);
      await expectStampedToBooking(bookingGroup);
      expect(settings.maintenanceGate).toBe(false);
    });
  },
);
