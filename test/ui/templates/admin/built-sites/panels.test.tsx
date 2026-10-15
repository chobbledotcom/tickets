import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  MaintenancePanel,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

describe("built site maintenance panel", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  test("offers provisioning when the site has no scheduled key", () => {
    const html = String(
      MaintenancePanel({
        monitor: { kind: "unconfigured" },
        site: testBuiltSite({ id: 42, scheduledTaskKey: null }),
      }),
    );

    says(html, "/admin/built-sites/42/provision-scheduler");
    says(html, "Set up scheduled maintenance");
    says(html, "on the builder");
    says(html, '<div class="prose">');
    assert(!html.includes("stage-scheduler"));
    assert(!html.includes("Site key"));
  });

  test("shows the site key with a resend action", () => {
    const html = String(
      MaintenancePanel({
        monitor: { kind: "missing" },
        site: testBuiltSite({
          id: 42,
          scheduledTaskKey: TEST_SCHEDULED_KEY,
        }),
      }),
    );

    says(html, `<code>${TEST_SCHEDULED_KEY}</code>`);
    says(html, `<strong>Site key</strong> <code>${TEST_SCHEDULED_KEY}</code>`);
    says(html, "/admin/built-sites/42/provision-scheduler");
    says(html, "Send key to site again");
    assert(!html.includes("stage-scheduler"));
    assert(!html.includes("promote-scheduler"));
    says(html, "No Uptime Kuma monitor exists for this site");
    says(html, "/admin/built-sites/42/add-uptime-monitor");
  });

  test("shows monitor details without exposing its request headers", () => {
    const html = String(
      MaintenancePanel({
        monitor: {
          kind: "found",
          monitor: {
            active: true,
            group: "Chobble Tickets",
            id: 17,
            intervalSeconds: 900,
            method: "POST",
            name: "A child",
            url: "https://child.example.test/scheduled",
          },
        },
        site: testBuiltSite({ scheduledTaskKey: TEST_SCHEDULED_KEY }),
      }),
    );

    says(html, "A child");
    says(html, "Chobble Tickets");
    says(html, "Every 15 minutes");
    says(html, "POST");
    says(html, "Active");
    assert(!html.includes("Authorization"));
    assert(!html.includes("add-uptime-monitor"));
  });

  test("shows Kuma connection errors", () => {
    const html = String(
      MaintenancePanel({
        monitor: { error: "connection refused", kind: "error" },
        site: testBuiltSite({ scheduledTaskKey: TEST_SCHEDULED_KEY }),
      }),
    );

    says(html, "Uptime Kuma could not be checked");
    says(html, "connection refused");
    assert(!html.includes("add-uptime-monitor"));
  });

  test("asks for the site key before offering a missing monitor", () => {
    const html = String(
      MaintenancePanel({
        monitor: { kind: "missing" },
        site: testBuiltSite({ scheduledTaskKey: null }),
      }),
    );

    says(html, "Set up scheduled maintenance before you add the monitor");
    assert(!html.includes("add-uptime-monitor"));
  });

  test("shows paused monitors with a seconds interval", () => {
    const html = String(
      MaintenancePanel({
        monitor: {
          kind: "found",
          monitor: {
            active: false,
            group: "Chobble Tickets",
            id: 18,
            intervalSeconds: 45,
            method: "POST",
            name: "Paused child",
            url: "https://paused.example.test/scheduled",
          },
        },
        site: testBuiltSite({ scheduledTaskKey: TEST_SCHEDULED_KEY }),
      }),
    );

    says(html, "Paused");
    says(html, "Every 45 seconds");
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
          pairConflicts: [],
          present: ["DB_URL", "DB_ENCRYPTION_KEY"],
        },
      }),
    );
    says(html, "/admin/built-sites/9/add-secrets");
    says(html, "<code>NTFY_URL</code>");
    says(html, "<code>STORAGE_ZONE_KEY</code>");
    says(html, "Set 2 missing secret(s)");
    says(html, "host-level infrastructure credentials");
    says(html, "Secrets currently on this site");
    says(html, "<code>DB_ENCRYPTION_KEY</code>");
    says(html, '<div class="prose">');
  });

  test("omits empty present and infrastructure sections", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["NTFY_URL"],
          missing: ["NTFY_URL"],
          ok: true,
          pairConflicts: [],
          present: [],
        },
      }),
    );
    assert(!html.includes("Secrets currently on this site"));
    assert(!html.includes("host-level infrastructure credentials"));
  });

  test("confirms when every expected secret is present", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["DB_URL", "NTFY_URL"],
          missing: [],
          ok: true,
          pairConflicts: [],
          present: ["DB_URL", "NTFY_URL"],
        },
      }),
    );
    says(html, '<output class="success">All expected secrets are present');
    assert(!html.includes("add-secrets"));
  });

  test("shows provider errors", () => {
    const html = String(
      SecretsPanel({
        site,
        view: { error: "provider failed", ok: false },
      }),
    );
    says(html, "provider failed");
    says(html, '<div class="prose">');
    assert(!html.includes("add-secrets"));
  });

  test("shows when secret status is unavailable", () => {
    says(
      String(SecretsPanel({ site })),
      '<p class="prose">Secrets status is unavailable',
    );
  });

  test("asks the operator before completing a half-held pair", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["BOTPOISON_PUBLIC_KEY", "BOTPOISON_SECRET_KEY"],
          missing: ["BOTPOISON_SECRET_KEY"],
          ok: true,
          pairConflicts: ["BOTPOISON_SECRET_KEY"],
          present: ["BOTPOISON_PUBLIC_KEY"],
        },
      }),
    );
    says(html, "Pair warning");
    says(html, "rejects every contact form submission");
    says(html, 'name="confirm_pair_secrets"');
    says(html, "required");
  });

  test("separates multiple missing infrastructure secrets", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["STORAGE_ZONE_NAME", "STORAGE_ZONE_KEY"],
          missing: ["STORAGE_ZONE_NAME", "STORAGE_ZONE_KEY"],
          ok: true,
          pairConflicts: [],
          present: [],
        },
      }),
    );

    says(html, "Heads up:</strong> some of these");
    says(html, "STORAGE_ZONE_NAME, STORAGE_ZONE_KEY");
  });

  test("shows a single present secret", () => {
    const html = String(
      SecretsPanel({
        site,
        view: {
          expected: ["DB_URL"],
          missing: [],
          ok: true,
          pairConflicts: [],
          present: ["DB_URL"],
        },
      }),
    );

    says(html, "Secrets currently on this site");
    says(html, "<code>DB_URL</code>");
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
    says(html, "Thu, 01 Jan 2026 00:00:00 UTC");
    says(html, "2099-01-01 - Big Update (v2099-01-01-120000)");
    says(
      html,
      "<strong>Latest known release:</strong> 2099-01-01 - Big Update",
    );
    says(html, "An update is available");
    says(html, "/admin/built-sites/42/update");
  });

  test("shows up-to-date state", () => {
    says(
      render({ updateAvailable: false, upToDate: true }),
      '<output class="success">This site is on the latest known release',
    );
  });

  test("keeps an empty stored site version label", () => {
    const html = render({
      siteVersionError: "must not replace the stored label",
      siteVersionLabel: "",
      updateAvailable: false,
    });

    says(html, "<strong>Site version:</strong> </p>");
    assert(!html.includes("must not replace the stored label"));
  });

  test("shows unknown when no database keys are stored", () => {
    says(
      render({ siteVersionLabel: null, updateAvailable: false }),
      "no read-only database credentials",
    );
  });

  test("shows the site version read error", () => {
    says(
      render({
        siteVersionError: "connection refused",
        siteVersionLabel: null,
        updateAvailable: false,
      }),
      "connection refused",
    );
  });

  test("shows when no release has been checked", () => {
    says(
      render({ latestVersion: "", updateAvailable: false }),
      "None checked yet",
    );
  });

  test("explains when automatic update is unavailable", () => {
    const html = render({
      providerConfigured: false,
      updateAvailable: false,
      upToDate: false,
    });
    says(html, "Automatic update needs the provider API key");
    assert(!html.includes("Update this site"));
  });
});
