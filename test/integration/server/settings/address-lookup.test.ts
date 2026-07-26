import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#shared/db/settings/mask.ts";
import { settings } from "#shared/db/settings.ts";
import { expectFlash, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const post = (data: Record<string, string>) =>
  adminFormPost("/admin/settings/address-lookup", data);

const saveEasypostcodes = () =>
  post({
    address_lookup_api_key: "epc-key-1",
    address_lookup_provider: "easypostcodes",
  });

describeWithEnv("server (admin settings: address lookup)", { db: true }, () => {
  describe("POST /admin/settings/address-lookup", () => {
    testRequiresAuth("/admin/settings/address-lookup", {
      body: { address_lookup_provider: "none" },
      method: "POST",
    });

    test("saves the provider and its API key", async () => {
      const { response } = await saveEasypostcodes();

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Address lookup settings updated"),
      );
      expect(settings.addressLookup.provider).toBe("easypostcodes");
      expect(settings.addressLookup.apiKey).toBe("epc-key-1");
    });

    test("rejects a provider outside the picklist", async () => {
      const { response } = await post({
        address_lookup_api_key: "k",
        address_lookup_provider: "surprise-provider",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Unknown address lookup provider"),
        false,
      );
      expect(settings.addressLookup.provider).toBe("none");
    });

    test("rejects enabling a provider with no API key", async () => {
      const { response } = await post({
        address_lookup_api_key: "",
        address_lookup_provider: "easypostcodes",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("An API key is required"),
        false,
      );
      expect(settings.addressLookup.provider).toBe("none");
      expect(settings.addressLookup.hasKey).toBe(false);
    });

    test("a masked key keeps the stored value when re-saving", async () => {
      await saveEasypostcodes();

      const { response } = await post({
        address_lookup_api_key: MASK_SENTINEL,
        address_lookup_provider: "easypostcodes",
      });

      expect(response.status).toBe(302);
      expect(settings.addressLookup.apiKey).toBe("epc-key-1");
    });

    test("a masked key with nothing stored cannot enable a provider", async () => {
      const { response } = await post({
        address_lookup_api_key: MASK_SENTINEL,
        address_lookup_provider: "easypostcodes",
      });

      expectFlash(
        response,
        expect.stringContaining("An API key is required"),
        false,
      );
      expect(settings.addressLookup.provider).toBe("none");
    });

    test("switching to none can clear the stored key", async () => {
      await saveEasypostcodes();

      await post({
        address_lookup_api_key: "",
        address_lookup_provider: "none",
      });

      expect(settings.addressLookup.provider).toBe("none");
      expect(settings.addressLookup.hasKey).toBe(false);
    });

    test("switching to none with a masked key keeps it for later", async () => {
      await saveEasypostcodes();

      await post({
        address_lookup_api_key: MASK_SENTINEL,
        address_lookup_provider: "none",
      });

      expect(settings.addressLookup.provider).toBe("none");
      expect(settings.addressLookup.apiKey).toBe("epc-key-1");
    });
  });

  describe("GET /admin/settings-advanced", () => {
    test("shows the address lookup section with the provider picklist", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain("settings-address-lookup");
      expect(html).toContain('name="address_lookup_provider"');
      expect(html).toContain(">EasyPostcodes</option>");
      expect(html).toContain('name="address_lookup_api_key"');
      expect(html).not.toContain(MASK_SENTINEL);
    });

    test("masks a stored API key instead of echoing it", async () => {
      await saveEasypostcodes();
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("epc-key-1");
    });
  });
});
