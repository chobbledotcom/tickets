import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { getAuthenticatedSession } from "#routes/auth.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestManagerSession,
  describeWithEnv,
  setTestEnv,
  testCookie,
} from "#test-utils";

// ---------------------------------------------------------------------------
// AdminSession.settingsNagItems population
// ---------------------------------------------------------------------------

const getOwnerSession = async () => {
  const cookie = await testCookie();
  const request = new Request("http://localhost/admin/", {
    headers: { cookie },
  });
  const session = await getAuthenticatedSession(request);
  expect(session).not.toBeNull();
  return session!;
};

describeWithEnv("AuthSession.settingsNagItems", { db: true }, () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    settings.clearTestOverride("superuser_choice");
  });

  test("owner session includes settingsNagItems computed via getSettingsNagItemsForOwner", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const session = await getOwnerSession();
    expect(session.adminLevel).toBe("owner");
    expect(session.settingsNagItems).toBeDefined();
    expect(Array.isArray(session.settingsNagItems)).toBe(true);
    expect(
      session.settingsNagItems!.every(
        (i) =>
          typeof i.id === "string" &&
          typeof i.label === "string" &&
          typeof i.href === "string",
      ),
    ).toBe(true);
  });

  test("non-owner session does NOT include settingsNagItems", async () => {
    const managerCookie = await createTestManagerSession();
    const request = new Request("http://localhost/admin/", {
      headers: { cookie: managerCookie },
    });
    const session = await getAuthenticatedSession(request);
    expect(session).not.toBeNull();
    expect(session!.adminLevel).toBe("manager");
    expect(session!.settingsNagItems).toBeUndefined();
  });

  test("settingsNagItems includes superuser nag when conditions are met", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "" });
    const session = await getOwnerSession();
    expect(session.settingsNagItems).toBeDefined();
    const hasSuperuser = session.settingsNagItems!.some(
      (i) => i.id === "superuser",
    );
    expect(hasSuperuser).toBe(true);
  });

  test("settingsNagItems does NOT include superuser nag when choice is already 'self-managed'", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "self-managed" });
    const session = await getOwnerSession();
    expect(session.settingsNagItems).toBeDefined();
    expect(session.settingsNagItems!.some((i) => i.id === "superuser")).toBe(
      false,
    );
  });
});
