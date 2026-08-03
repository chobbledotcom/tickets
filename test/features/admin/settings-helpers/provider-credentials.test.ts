import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { it as test } from "@std/testing/bdd";
import { defineProviderCredentialsRoute } from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Fields = { merchant: string };
type Config = Parameters<typeof defineProviderCredentialsRoute<Fields>>[0];

const makeProviderRoute = (overrides: Partial<Config> = {}) => {
  const saveSecret = fn((_value: string, _keepSalesOff: boolean) =>
    Promise.resolve(null),
  ) as unknown as Config["saveSecret"] & ReturnType<typeof fn>;
  const saveFields = fn((_fields: Fields) =>
    Promise.resolve(),
  ) as unknown as NonNullable<Config["saveFields"]> & ReturnType<typeof fn>;
  const routes = defineProviderCredentialsRoute<Fields>({
    extraFields: (form) => ({ merchant: form.getString("merchant") }),
    formId: "settings-test-provider",
    hasSecret: () => false,
    logMessage: "Test provider credentials updated",
    provider: "stripe",
    saveFields,
    saveSecret,
    secretField: "secret",
    secretRequiredError: "Secret is required",
    successMessage: "Test provider credentials saved",
    testFn: () => Promise.resolve({ ok: true }),
    validate: () => null,
    ...overrides,
  });
  return { routes, saveFields, saveSecret };
};

const post = async (
  handler: (request: Request) => Promise<Response>,
  fields: Record<string, string>,
): Promise<Response> =>
  handler(
    mockFormRequest(
      "/admin/settings/test-provider",
      { csrf_token: await testCsrfToken(), ...fields },
      await testCookie(),
    ),
  );

describeWithEnv("provider credential route", { db: true }, () => {
  test("saves credentials, selects the provider, and logs the change", async () => {
    const { routes, saveFields, saveSecret } = makeProviderRoute();
    const response = await post(routes.save, {
      merchant: "merchant-1",
      secret: "new-secret",
    });

    expectRedirectWithFlash(
      "/admin/settings?form=settings-test-provider#settings-test-provider",
      "Test provider credentials saved",
    )(response);
    expect(saveSecret).toHaveBeenCalledWith("new-secret", false);
    expect(saveFields).toHaveBeenCalledWith({ merchant: "merchant-1" });
    expect(settings.paymentProvider).toBe("stripe");
    expect((await getAllActivityLog()).at(-1)?.message).toBe(
      "Test provider credentials updated",
    );
  });

  test("keeps sales off while updating credentials", async () => {
    await settings.update.setPaymentProviderNone();
    const { routes, saveSecret } = makeProviderRoute();
    await post(routes.save, { merchant: "merchant-1", secret: "new-secret" });

    expect(saveSecret).toHaveBeenCalledWith("new-secret", true);
    expect(settings.paymentProvider).toBeNull();
    expect(settings.paymentProviderSetting).toBe("none");
  });

  test("allows an empty field when a secret is already stored", async () => {
    const { routes, saveFields, saveSecret } = makeProviderRoute({
      hasSecret: () => true,
    });
    const response = await post(routes.save, {
      merchant: "updated-merchant",
      secret: "",
    });

    expectFlash(response, "Test provider credentials saved");
    expect(saveSecret).not.toHaveBeenCalled();
    expect(saveFields).toHaveBeenCalledWith({ merchant: "updated-merchant" });
  });

  test("requires an empty secret when none is stored", async () => {
    const { routes, saveFields } = makeProviderRoute();
    const response = await post(routes.save, {
      merchant: "merchant-1",
      secret: "",
    });

    expectFlash(response, "Secret is required", false);
    expect(saveFields).not.toHaveBeenCalled();
  });
});
