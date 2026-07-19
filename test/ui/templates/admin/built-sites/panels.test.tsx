import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  MaintenancePanel,
  renewalPanelFor,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

describe("built site maintenance panel", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  test("offers provisioning when the site has no scheduled key", () => {
    const html = String(
      MaintenancePanel({
        site: testBuiltSite({ id: 42, scheduledTaskKey: null }),
      }),
    );

    expect(html).toContain("/admin/built-sites/42/provision-scheduler");
    expect(html).toContain("Set up scheduled maintenance");
    expect(html).toContain('<div class="prose">');
    expect(html).not.toContain("stage-scheduler");
  });

  test("shows the site key with a resend action", () => {
    const html = String(
      MaintenancePanel({
        site: testBuiltSite({
          id: 42,
          scheduledTaskKey: TEST_SCHEDULED_KEY,
        }),
      }),
    );

    expect(html).toContain(`<code>${TEST_SCHEDULED_KEY}</code>`);
    expect(html).toContain(
      `<strong>Site key</strong> <code>${TEST_SCHEDULED_KEY}</code>`,
    );
    expect(html).toContain("/admin/built-sites/42/provision-scheduler");
    expect(html).toContain("Send key to site again");
    expect(html).not.toContain("stage-scheduler");
    expect(html).not.toContain("promote-scheduler");
  });
});

describe("renewal panel", () => {
  const provisionedSite = testBuiltSite({
    readOnlyFrom: "2027-01-15T00:00:00Z",
    renewalToken: "real-customer-renewal-token",
    renewalTokenIndex: "some-index",
  });
  const unprovisionedSite = testBuiltSite({
    readOnlyFrom: "",
    renewalTokenIndex: null,
  });

  test("shows every provisioned-site action and the real renewal URL", () => {
    const html = String(renewalPanelFor(provisionedSite));
    expect(html).toContain("/renew/?t=real-customer-renewal-token");
    expect(html).toContain("rotate-renewal-token");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).toContain("re-sync-deadline");
    expect(html).toContain(
      '<input id="bump_months" max="120" min="1" name="months" type="number" value="1">',
    );
    expect(html).toContain(
      '<input id="override_date" name="date" type="date">',
    );
    expect(html).toContain("<strong>Renewal URL:</strong> <code>");
    expect(html).not.toContain("tier_listing_id");
  });

  test("labels provisioned deadline forms inline", () => {
    const html = String(renewalPanelFor(provisionedSite));
    expect(html).toContain('<label for="bump_months">Bump deadline by months');
    expect(html).toContain('<label for="override_date">Override deadline');
    expect(html).not.toContain("<h3>Bump deadline</h3>");
  });

  test("shows provisioning and deadline actions for an unprovisioned site", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    expect(html).toContain("provision-renewal");
    expect(html).toContain("bump-deadline");
    expect(html).toContain("override-deadline");
    expect(html).not.toContain("rotate-renewal-token");
    expect(html).not.toContain("re-sync-deadline");
    expect(html).toContain(
      '<label for="provision_months">Initial months</label><input id="provision_months" max="120" min="1" name="months" type="number" value="1">',
    );
  });

  test("labels unprovisioned deadline forms with headings", () => {
    const html = String(renewalPanelFor(unprovisionedSite));
    expect(html).toContain("<h3>Bump deadline</h3>");
    expect(html).toContain("<h3>Override deadline</h3>");
    expect(html).not.toContain('for="bump_months"');
    expect(html).not.toContain('for="override_date"');
  });

  test("omits raw deadline details when no deadline is set", () => {
    const html = String(
      renewalPanelFor(
        testBuiltSite({
          readOnlyFrom: "",
          renewalToken: "renewal-token",
          renewalTokenIndex: "renewal-index",
        }),
      ),
    );

    expect(html).not.toContain("<details>");
    expect(html).not.toContain("Raw ISO value");
  });
});

describe("secrets panel", () => {
  const site = testBuiltSite({ id: 9, name: "Sec" });

  test("lists missing, infrastructure, and present secrets", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["DB_URL", "NTFY_URL", "STORAGE_ZONE_KEY"],
          missing: ["NTFY_URL", "STORAGE_ZONE_KEY"],
          ok: true,
          present: ["DB_URL", "DB_ENCRYPTION_KEY"],
        },
      }),
    );
    expect(html).toContain("/admin/built-sites/9/add-secrets");
    expect(html).toContain("<code>NTFY_URL</code>");
    expect(html).toContain("<code>STORAGE_ZONE_KEY</code>");
    expect(html).toContain("Set 2 missing secret(s)");
    expect(html).toContain("host-level infrastructure credentials");
    expect(html).toContain("Secrets currently on this site");
    expect(html).toContain("<code>DB_ENCRYPTION_KEY</code>");
    expect(html).toContain('<div class="prose">');
  });

  test("omits empty present and infrastructure sections", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["NTFY_URL"],
          missing: ["NTFY_URL"],
          ok: true,
          present: [],
        },
      }),
    );
    expect(html).not.toContain("Secrets currently on this site");
    expect(html).not.toContain("host-level infrastructure credentials");
  });

  test("confirms when every expected secret is present", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["DB_URL", "NTFY_URL"],
          missing: [],
          ok: true,
          present: ["DB_URL", "NTFY_URL"],
        },
      }),
    );
    expect(html).toContain(
      '<output class="success">All expected secrets are present',
    );
    expect(html).not.toContain("add-secrets");
  });

  test("shows provider errors", () => {
    const html = String(
      SecretsPanel({
        site,
        view: { error: "provider failed", ok: false },
      }),
    );
    expect(html).toContain("provider failed");
    expect(html).toContain('<div class="prose">');
    expect(html).not.toContain("add-secrets");
  });

  test("shows when secret status is unavailable", () => {
    expect(String(SecretsPanel({ site }))).toContain(
      '<p class="prose">Secrets status is unavailable',
    );
  });

  test("separates multiple missing infrastructure secrets", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["STORAGE_ZONE_NAME", "STORAGE_ZONE_KEY"],
          missing: ["STORAGE_ZONE_NAME", "STORAGE_ZONE_KEY"],
          ok: true,
          present: [],
        },
      }),
    );

    expect(html).toContain("Heads up:</strong> some of these");
    expect(html).toContain("STORAGE_ZONE_NAME, STORAGE_ZONE_KEY");
  });

  test("shows a single present secret", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["DB_URL"],
          missing: [],
          ok: true,
          present: ["DB_URL"],
        },
      }),
    );

    expect(html).toContain("Secrets currently on this site");
    expect(html).toContain("<code>DB_URL</code>");
  });
});

describe("update panel", () => {
  const site = testBuiltSite({ id: 42, name: "Panel Site" });
  const baseState = {
    hasHostingId: true,
    latestVersion: "v2099-01-01-120000",
    latestVersionName: "2099-01-01 - Big Update",
    providerConfigured: true,
    siteVersionError: null as string | null,
    siteVersionLabel: "Thu, 01 Jan 2026 00:00:00 UTC" as string | null,
    updateAvailable: true,
    upToDate: false,
  };
  const render = (overrides: Partial<typeof baseState> = {}): string =>
    String(UpdatePanel({ site, state: { ...baseState, ...overrides } }));

  test("shows the versions and update action when behind", () => {
    const html = render();
    expect(html).toContain("Thu, 01 Jan 2026 00:00:00 UTC");
    expect(html).toContain("2099-01-01 - Big Update (v2099-01-01-120000)");
    expect(html).toContain(
      "<strong>Latest known release:</strong> 2099-01-01 - Big Update",
    );
    expect(html).toContain("An update is available");
    expect(html).toContain("/admin/built-sites/42/update");
  });

  test("shows up-to-date state", () => {
    expect(render({ updateAvailable: false, upToDate: true })).toContain(
      '<output class="success">This site is on the latest known release',
    );
  });

  test("keeps an empty stored site version label", () => {
    const html = render({
      siteVersionError: "must not replace the stored label",
      siteVersionLabel: "",
      updateAvailable: false,
    });

    expect(html).toContain("<strong>Site version:</strong> </p>");
    expect(html).not.toContain("must not replace the stored label");
  });

  test("shows unknown when no database keys are stored", () => {
    expect(
      render({ siteVersionLabel: null, updateAvailable: false }),
    ).toContain("no read-only database credentials");
  });

  test("shows the site version read error", () => {
    expect(
      render({
        siteVersionError: "connection refused",
        siteVersionLabel: null,
        updateAvailable: false,
      }),
    ).toContain("connection refused");
  });

  test("shows when no release has been checked", () => {
    expect(render({ latestVersion: "", updateAvailable: false })).toContain(
      "None checked yet",
    );
  });

  test("explains when automatic update is unavailable", () => {
    const html = render({
      providerConfigured: false,
      updateAvailable: false,
      upToDate: false,
    });
    expect(html).toContain("Automatic update needs the provider API key");
    expect(html).not.toContain("Update this site");
  });
});
