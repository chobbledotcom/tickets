import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { defineProviderCredentialsRoute } from "#routes/admin/settings-provider-credentials.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Fields = { merchant: string };

/** The route reads the secret out of the field the registry names for the
 * provider it is built for, so the fake posts under that name too. */
const SECRET_FIELD = PAYMENT_PROVIDERS.stripe.secretField;
type Config = Parameters<typeof defineProviderCredentialsRoute<Fields>>[0];

/** The route reads "a secret is already stored" from the provider's own
 * settings, so a test that needs that state stores a real key. */
const storeProviderSecret = (): Promise<void> =>
  settings.update.stripe.secretKey("sk_test_stored_key");

const makeProviderRoute = (overrides: Partial<Config> = {}) => {
  const saveSecret = fn((_value: string, _activateFromMissing: boolean) =>
    Promise.resolve(null),
  ) as unknown as Config["saveSecret"] & ReturnType<typeof fn>;
  const saveFields = fn((_fields: Fields) =>
    Promise.resolve(),
  ) as unknown as NonNullable<Config["saveFields"]> & ReturnType<typeof fn>;
  const routes = defineProviderCredentialsRoute<Fields>({
    extraFields: (form) => ({ merchant: form.getString("merchant") }),
    logMessage: "Test provider credentials updated",
    provider: "stripe",
    saveFields,
    saveSecret,
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
): Promise<Response> => {
  await settings.loadKeys([]);
  return handler(
    mockFormRequest(
      "/admin/settings/test-provider",
      {
        csrf_token: await testCsrfToken(),
        settings_version: String(settings.version),
        ...fields,
      },
      await testCookie(),
    ),
  );
};

const saveCredentialsWhile = async (
  changeSetting: () => Promise<void>,
): Promise<void> => {
  const saveStarted = Promise.withResolvers<void>();
  const releaseSave = Promise.withResolvers<void>();
  const { routes } = makeProviderRoute({
    saveSecret: async () => {
      saveStarted.resolve();
      await releaseSave.promise;
    },
  });
  const saving = post(routes.save, {
    merchant: "merchant-1",
    [SECRET_FIELD]: "new-secret",
  });
  await saveStarted.promise;
  await changeSetting();
  releaseSave.resolve();
  await saving;
};

describeWithEnv("provider credential route", { db: true }, () => {
  test("saves credentials, selects the provider, and logs the change", async () => {
    const { routes, saveFields, saveSecret } = makeProviderRoute();
    const response = await post(routes.save, {
      merchant: "merchant-1",
      [SECRET_FIELD]: "new-secret",
    });

    expectRedirectWithFlash(
      "/admin/settings?form=settings-stripe#settings-stripe",
      "Test provider credentials saved",
    )(response);
    expect(saveSecret).toHaveBeenCalledWith("new-secret", true);
    expect(saveFields).toHaveBeenCalledWith({ merchant: "merchant-1" });
    expect(settings.paymentProvider).toBe("stripe");
    expect((await getAllActivityLog()).at(-1)?.message).toBe(
      "Test provider credentials updated",
    );
  });

  test("keeps sales off while updating credentials", async () => {
    await settings.update.setPaymentProviderNone();
    const { routes, saveSecret } = makeProviderRoute();
    await post(routes.save, {
      merchant: "merchant-1",
      [SECRET_FIELD]: "new-secret",
    });

    expect(saveSecret).toHaveBeenCalledWith("new-secret", true);
    expect(settings.paymentProvider).toBeNull();
    expect(settings.paymentProviderSetting).toBe("none");
  });

  test("keeps sales off when they are disabled during a credential save", async () => {
    await settings.update.paymentProvider("square");
    await saveCredentialsWhile(settings.update.setPaymentProviderNone);

    expect(settings.paymentProvider).toBeNull();
    expect(settings.paymentProviderSetting).toBe("none");
  });

  test("keeps a provider selected during a stale credential save", async () => {
    await settings.update.paymentProvider("stripe");
    await saveCredentialsWhile(() => settings.update.paymentProvider("square"));

    expect(settings.paymentProvider).toBe("square");
    expect(settings.lastActivePaymentProvider).toBe("square");
  });

  test("does not save credentials while another settings task runs", async () => {
    await settings.update.currentTask("custom-domain");
    try {
      const { routes, saveFields, saveSecret } = makeProviderRoute();
      const response = await post(routes.save, {
        merchant: "merchant-1",
        [SECRET_FIELD]: "new-secret",
      });

      expectFlash(response, "Another task is already in progress", false);
      expect(saveSecret).not.toHaveBeenCalled();
      expect(saveFields).not.toHaveBeenCalled();
    } finally {
      await settings.update.currentTask("");
    }
  });

  test("keeps sales off when the legacy provider setting is missing", async () => {
    await settings.update.clearPaymentProvider();
    await storeProviderSecret();
    const { routes } = makeProviderRoute();
    await post(routes.save, { merchant: "merchant-1", [SECRET_FIELD]: "" });

    expect(settings.paymentProvider).toBeNull();
    expect(settings.paymentProviderSetting).toBe("none");
  });

  test("allows an empty field when a secret is already stored", async () => {
    await storeProviderSecret();
    const { routes, saveFields, saveSecret } = makeProviderRoute();
    const response = await post(routes.save, {
      merchant: "updated-merchant",
      [SECRET_FIELD]: "",
    });

    expectFlash(response, "Test provider credentials saved");
    expect(saveSecret).not.toHaveBeenCalled();
    expect(saveFields).toHaveBeenCalledWith({ merchant: "updated-merchant" });
  });

  test("requires an empty secret when none is stored", async () => {
    const { routes, saveFields } = makeProviderRoute();
    const response = await post(routes.save, {
      merchant: "merchant-1",
      [SECRET_FIELD]: "",
    });

    expectFlash(response, "Secret is required", false);
    expect(saveFields).not.toHaveBeenCalled();
  });
});
