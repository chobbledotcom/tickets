import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  adminDebugPage,
  SENTRY_TEST_FORM_ID,
} from "#templates/admin/debug.tsx";
import { debugOwnerSession, makeDebugState } from "#test-utils/debug.ts";

const rowValues = (html: string, label: string): string[] => {
  const marker = `<tr><td>${label}</td><td>`;
  return html
    .split(marker)
    .slice(1)
    .map((rest) => {
      const end = rest.indexOf("</td></tr>");
      if (end < 0) throw new Error(`Debug row did not end: ${label}`);
      return rest.slice(0, end);
    });
};

const expectBadgeRow = (
  html: string,
  rowLabel: string,
  variant: "missing" | "ok",
  badgeLabel: string,
): void => {
  const values = rowValues(html, rowLabel);
  expect(values).toHaveLength(1);
  expect(values[0]).toContain(`class="badge-${variant}"`);
  expect(values[0]).toContain(`>${badgeLabel}</span>`);
};

describe("admin debug template rendering", () => {
  test("keeps the debug navigation and section structure", () => {
    const html = adminDebugPage(debugOwnerSession, makeDebugState());

    expect(html).toContain('href="/admin/debug"');
    expect([...html.matchAll(/class="prose"/g)]).toHaveLength(2);
    expect([...html.matchAll(/class="table-scroll"/g)]).toHaveLength(12);
  });

  test("shows every missing value in its own row", () => {
    const html = adminDebugPage(debugOwnerSession, makeDebugState());
    const missingValue = "—";
    const missingValueLabels = [
      "debug.field.timestamp",
      "debug.field.commit",
      "debug.field.deno_version",
      "debug.field.v8_version",
      "debug.field.typescript_version",
      "debug.field.node_compatibility",
      "debug.field.os_architecture",
      "debug.field.user_agent",
      "debug.field.country",
      "debug.field.currency",
      "debug.field.timezone",
      "debug.field.read_only_from",
      "debug.field.pass_type_id",
      "debug.field.issuer_id",
      "debug.field.mode",
      "debug.field.from_address",
      "debug.field.cdn_hostname",
      "debug.field.custom_domain",
      "debug.field.subdomain_suffix",
      "debug.field.registered_subdomain",
      "debug.field.database_host",
    ] as const;

    for (const label of missingValueLabels) {
      expect(rowValues(html, t(label))).toEqual([missingValue]);
    }

    expect(rowValues(html, t("debug.field.active_source"))).toEqual([
      t("common.none"),
      t("common.none"),
    ]);
    expect(rowValues(html, t("debug.field.provider"))).toEqual([
      t("common.none"),
    ]);
    expect(rowValues(html, t("debug.field.provider_db"))).toEqual([
      t("common.none"),
    ]);
    expect(rowValues(html, t("debug.field.host_provider_env"))).toEqual([
      t("common.none"),
    ]);
  });

  test("renders every supplied configuration value", () => {
    const html = adminDebugPage(
      debugOwnerSession,
      makeDebugState({
        appleWallet: {
          certValidation: {
            signingCert: "signing-cert-marker",
            signingKey: "signing-key-marker",
            wwdrCert: "wwdr-cert-marker",
          },
          dbConfigured: true,
          envConfigured: true,
          passTypeId: "pass-type-marker",
          source: "apple-source-marker",
        },
        availability: {
          cutoff: "cutoff-marker",
          renewalConfigured: true,
          serverTime: "server-time-marker",
          state: "active",
        },
        build: {
          commit: "commit-marker",
          timestamp: "timestamp-marker",
        },
        bunny: {
          cdnEnabled: true,
          cdnHostname: "cdn-host-marker",
          customDomain: "custom-domain-marker",
          dnsEnabled: true,
          registeredSubdomain: "registered-subdomain-marker",
          storageBackend: "bunny",
          subdomainSuffix: "subdomain-suffix-marker",
        },
        database: {
          host: "turso" as const,
          hostConfigured: true,
          schemaHash: "schema-hash-marker",
          schemaInSync: true,
        },
        domain: "domain-marker",
        email: {
          apiKeyConfigured: true,
          fromAddress: "from-address-marker",
          hostProvider: "host-provider-marker",
          provider: "email-provider-marker",
        },
        googleWallet: {
          dbConfigured: true,
          envConfigured: true,
          issuerId: "issuer-marker",
          privateKeyValid: "private-key-marker",
          source: "google-source-marker",
        },
        limits: [],
        notifications: { ntfyConfigured: true, sentryConfigured: true },
        payment: {
          keyConfigured: true,
          mode: "payment-mode-marker",
          provider: "payment-provider-marker",
          webhookConfigured: true,
        },
        runtime: {
          arch: "arch-marker",
          denoVersion: "deno-marker",
          nodeCompatVersion: "node-marker",
          os: "os-marker",
          runtime: "bunny",
          typescriptVersion: "typescript-marker",
          userAgent: "user-agent-marker",
          v8Version: "v8-marker",
        },
        site: {
          bookingFee: "2.5",
          contactForm: true,
          country: "country-marker",
          currency: "currency-marker",
          publicApi: true,
          publicSite: true,
          spamProtection: true,
          timezone: "timezone-marker",
        },
        theme: "dark",
      }),
    );
    const values = [
      "signing-cert-marker",
      "signing-key-marker",
      "wwdr-cert-marker",
      "pass-type-marker",
      "apple-source-marker",
      "cutoff-marker",
      "server-time-marker",
      "commit-marker",
      "timestamp-marker",
      "cdn-host-marker",
      "custom-domain-marker",
      "registered-subdomain-marker",
      "subdomain-suffix-marker",
      "schema-hash-marker",
      "domain-marker",
      "from-address-marker",
      "host-provider-marker",
      "email-provider-marker",
      "issuer-marker",
      "private-key-marker",
      "google-source-marker",
      "payment-mode-marker",
      "payment-provider-marker",
      "bunny",
      "deno-marker",
      "node-marker",
      "typescript-marker",
      "user-agent-marker",
      "v8-marker",
      "country-marker",
      "currency-marker",
      "timezone-marker",
      "2.5%",
    ];

    for (const value of values) expect(html).toContain(value);
    expect(rowValues(html, t("debug.field.os_architecture"))).toEqual([
      "os-marker / arch-marker",
    ]);
    expectBadgeRow(html, t("debug.field.public_site"), "ok", "Visible");
    expectBadgeRow(html, t("debug.field.public_api"), "ok", "Enabled");
    expectBadgeRow(html, t("debug.field.contact_form"), "ok", "Enabled");
    expectBadgeRow(html, t("debug.field.schema_status"), "ok", "Up to date");
    expect(html).toContain(`action="/admin/debug/sentry"`);
    expect(html).toContain(`class="inline"`);
    expect(html).toContain(`id="${SENTRY_TEST_FORM_ID}"`);
    expect(html).toContain(`>${t("debug.test_sentry")}</button>`);
  });

  test("renders the disabled site and database states", () => {
    const html = adminDebugPage(debugOwnerSession, makeDebugState());

    expectBadgeRow(html, t("debug.field.public_site"), "missing", "Hidden");
    expectBadgeRow(html, t("debug.field.public_api"), "missing", "Disabled");
    expectBadgeRow(html, t("debug.field.contact_form"), "missing", "Disabled");
    expectBadgeRow(
      html,
      t("debug.field.schema_status"),
      "missing",
      "Out of sync",
    );
    expectBadgeRow(html, "DB_URL", "missing", t("common.not_configured"));
  });

  test("renders each availability state", () => {
    const expected = {
      active: { label: "Active", variant: "ok" },
      readonly: { label: "Read-only", variant: "missing" },
      warning: { label: "Expiring soon", variant: "missing" },
    } as const;

    for (const [state, stateBadge] of Object.entries(expected)) {
      const pageState = makeDebugState();
      pageState.availability.state = state as keyof typeof expected;
      const html = adminDebugPage(debugOwnerSession, pageState);
      expectBadgeRow(
        html,
        t("debug.field.write_access"),
        stateBadge.variant,
        stateBadge.label,
      );
    }
  });

  test("renders each storage backend", () => {
    const expected = {
      bunny: { label: "Bunny CDN", variant: "ok" },
      local: { label: "Local filesystem", variant: "ok" },
      none: { label: "Not configured", variant: "missing" },
    } as const;

    for (const [backend, backendBadge] of Object.entries(expected)) {
      const pageState = makeDebugState();
      pageState.bunny.storageBackend = backend as keyof typeof expected;
      const html = adminDebugPage(debugOwnerSession, pageState);
      expectBadgeRow(
        html,
        t("debug.field.file_storage_images"),
        backendBadge.variant,
        backendBadge.label,
      );
    }
  });

  test("marks only changed limits as overridden", () => {
    const html = adminDebugPage(
      debugOwnerSession,
      makeDebugState({
        limits: [
          {
            current: 100,
            defaultValue: 100,
            envKey: "DEFAULT_LIMIT",
            label: "Default limit",
            unit: "bytes",
          },
          {
            current: 200,
            defaultValue: 100,
            envKey: "OVERRIDDEN_LIMIT",
            label: "Overridden limit",
            unit: "bytes",
          },
        ],
      }),
    );

    expect(html).toContain("<td><span>100B</span></td>");
    expect(html).toContain(
      `<td><strong>200B ${t("debug.overridden")}</strong></td>`,
    );
    expect(html).toContain("DEFAULT_LIMIT");
    expect(html).toContain("OVERRIDDEN_LIMIT");
  });

  test("uses the stable Sentry test form id", () => {
    expect(SENTRY_TEST_FORM_ID).toBe("debug-sentry-test");
  });
});
