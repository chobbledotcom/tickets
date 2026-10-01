import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getUserByUsername } from "#db/users.ts";
import { handleRequest } from "#routes";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  seedV1User,
  sharesOwnerDataKey,
  unwrapUserKey,
} from "#test-utils/kek.ts";
import { mockAdminLoginRequest } from "#test-utils/mocks.ts";

describeWithEnv("login as a legacy v1 user", { db: true }, () => {
  test("first login signs in and re-wraps the DATA_KEY under the password", async () => {
    const seeded = await seedV1User("v1-login", "v1pass12345");
    expect(seeded.kek_version).toBe(1);
    const oldWrap = seeded.wrapped_data_key;

    const response = await handleRequest(
      await mockAdminLoginRequest({
        password: "v1pass12345",
        username: "v1-login",
      }),
    );

    expectRedirectWithFlash("/admin", "Logged in")(response);
    const migrated = (await getUserByUsername("v1-login"))!;
    expect(migrated.kek_version).toBe(2);
    expect(migrated.wrapped_data_key).not.toBe(oldWrap);
    const dataKey = await unwrapUserKey(migrated, "v1pass12345");
    expect(await sharesOwnerDataKey(dataKey)).toBe(true);
  });
});
