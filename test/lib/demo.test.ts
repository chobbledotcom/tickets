import { afterAll, afterEach, beforeAll, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { createTestDbWithSetup, mockRequest, resetDb, setupTestEncryptionKey } from "#test-utils";
import {
  applyDemoOverrides,
  ATTENDEE_DEMO_FIELDS,
  DEMO_EMAILS,
  DEMO_EVENT_DESCRIPTIONS,
  DEMO_EVENT_LOCATIONS,
  DEMO_EVENT_NAMES,
  DEMO_GROUP_NAMES,
  DEMO_HOLIDAY_NAMES,
  DEMO_NAMES,
  DEMO_PHONES,
  type DemoFieldMap,
  EVENT_DEMO_FIELDS,
  isDemoMode,
  resetDemoMode,
  wrapResourceForDemo,
} from "#lib/demo.ts";

describe("demo", () => {
  beforeEach(() => {
    Deno.env.delete("DEMO_MODE");
    resetDemoMode();
  });

  afterEach(() => {
    Deno.env.delete("DEMO_MODE");
    resetDemoMode();
  });

  describe("isDemoMode", () => {
    test("returns false when DEMO_MODE is not set", () => {
      expect(isDemoMode()).toBe(false);
    });

    test("returns true when DEMO_MODE is 'true'", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      expect(isDemoMode()).toBe(true);
    });

    test("returns false when DEMO_MODE is any other value", () => {
      Deno.env.set("DEMO_MODE", "false");
      resetDemoMode();
      expect(isDemoMode()).toBe(false);
    });

    test("caches the result across calls", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      expect(isDemoMode()).toBe(true);
      // Change env after first call - should still return cached value
      Deno.env.set("DEMO_MODE", "false");
      expect(isDemoMode()).toBe(true);
    });

    test("resetDemoMode clears the cache", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      expect(isDemoMode()).toBe(true);
      Deno.env.set("DEMO_MODE", "false");
      resetDemoMode();
      expect(isDemoMode()).toBe(false);
    });
  });

  describe("applyDemoOverrides", () => {
    test("returns form unchanged when demo mode is off", () => {
      const form = new URLSearchParams({ name: "Real Name", email: "real@example.com" });
      const result = applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      expect(result.get("name")).toBe("Real Name");
      expect(result.get("email")).toBe("real@example.com");
    });

    test("replaces fields that exist in the form when demo mode is on", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const form = new URLSearchParams({ name: "Real Name", email: "real@example.com" });
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      expect(form.get("name")).not.toBe("Real Name");
      expect(DEMO_NAMES as readonly string[]).toContain(form.get("name"));
      expect(form.get("email")).not.toBe("real@example.com");
      expect(DEMO_EMAILS as readonly string[]).toContain(form.get("email"));
    });

    test("skips fields not present in the form", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const form = new URLSearchParams({ name: "Real Name" });
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      expect(form.has("email")).toBe(false);
      expect(form.has("phone")).toBe(false);
    });

    test("skips empty-string fields", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const form = new URLSearchParams({ name: "Real Name", email: "" });
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      expect(form.get("email")).toBe("");
      expect(DEMO_NAMES as readonly string[]).toContain(form.get("name"));
    });

    test("returns the same form instance", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const form = new URLSearchParams({ name: "Test" });
      const result = applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      expect(result).toBe(form);
    });

    test("does not modify fields not in the mapping", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const form = new URLSearchParams({ name: "Real", csrf_token: "abc123" });
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      expect(form.get("csrf_token")).toBe("abc123");
    });

    test("works with event demo fields", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const form = new URLSearchParams({
        name: "My Event",
        description: "My description",
        location: "My location",
      });
      applyDemoOverrides(form, EVENT_DEMO_FIELDS);
      expect(DEMO_EVENT_NAMES as readonly string[]).toContain(form.get("name"));
      expect(DEMO_EVENT_DESCRIPTIONS as readonly string[]).toContain(form.get("description"));
      expect(DEMO_EVENT_LOCATIONS as readonly string[]).toContain(form.get("location"));
    });
  });

  describe("wrapResourceForDemo", () => {
    const makeFakeResource = () => {
      let lastCreateForm: URLSearchParams | null = null;
      let lastUpdateForm: URLSearchParams | null = null;

      const resource = {
        table: {} as never,
        fields: [],
        parseInput: (_form: URLSearchParams) => Promise.resolve({ ok: true as const, input: {} }),
        parsePartialInput: (_form: URLSearchParams) => Promise.resolve({ ok: true as const, input: {} }),
        create: (form: URLSearchParams) => { lastCreateForm = form; return Promise.resolve({ ok: true as const, row: { id: 1, name: "" } }); },
        update: (_id: unknown, form: URLSearchParams) => { lastUpdateForm = form; return Promise.resolve({ ok: true as const, row: { id: 1, name: "" } }); },
        delete: () => Promise.resolve({ ok: true as const }),
        verifyName: (_row: unknown, _name: string) => true,
      };
      return { resource, getLastCreateForm: () => lastCreateForm, getLastUpdateForm: () => lastUpdateForm };
    };

    test("delegates create with demo overrides applied", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();

      const { resource, getLastCreateForm } = makeFakeResource();
      const wrapped = wrapResourceForDemo(resource, { name: DEMO_GROUP_NAMES } as DemoFieldMap);

      const form = new URLSearchParams({ name: "Real Group" });
      wrapped.create(form);

      // applyDemoOverrides mutates the form in place before passing to resource
      expect(DEMO_GROUP_NAMES as readonly string[]).toContain(getLastCreateForm()!.get("name"));
    });

    test("delegates update with demo overrides applied", () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();

      const { resource, getLastUpdateForm } = makeFakeResource();
      const wrapped = wrapResourceForDemo(resource, { name: DEMO_HOLIDAY_NAMES } as DemoFieldMap);

      const form = new URLSearchParams({ name: "Real Holiday" });
      wrapped.update(42, form);

      expect(DEMO_HOLIDAY_NAMES as readonly string[]).toContain(getLastUpdateForm()!.get("name"));
    });

    test("preserves verifyName from original resource", () => {
      const { resource } = makeFakeResource();
      const wrapped = wrapResourceForDemo(resource, { name: DEMO_NAMES } as DemoFieldMap);
      expect(wrapped.verifyName).toBe(resource.verifyName);
    });

    test("does not apply overrides when demo mode is off", () => {
      const { resource, getLastCreateForm } = makeFakeResource();
      const wrapped = wrapResourceForDemo(resource, { name: DEMO_NAMES } as DemoFieldMap);

      const form = new URLSearchParams({ name: "Unchanged" });
      wrapped.create(form);

      expect(getLastCreateForm()!.get("name")).toBe("Unchanged");
    });
  });

  describe("demo data arrays", () => {
    test("demo emails have valid format", () => {
      for (const email of DEMO_EMAILS) {
        expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      }
    });

    test("demo phones have valid format", () => {
      for (const phone of DEMO_PHONES) {
        expect(phone).toMatch(/^\+44/);
      }
    });
  });

  describe("layout banner integration", () => {
    beforeAll(async () => {
      setupTestEncryptionKey();
      Deno.env.set("ALLOWED_DOMAIN", "localhost");
      await createTestDbWithSetup();
    });

    afterAll(() => {
      resetDb();
    });

    test("renders demo banner in page when demo mode is active", async () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();
      const response = await handleRequest(mockRequest("/admin/login"));
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Demo Mode");
    });
  });
});
