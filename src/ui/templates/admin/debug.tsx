/**
 * Admin debug page template - shows configuration status for troubleshooting
 */

import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { formatLimitValue, type LIMIT_ENTRIES } from "#shared/limits.ts";
import type { RuntimeInfo } from "#shared/runtime.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { themedAdminPage } from "#templates/admin/admin-page.tsx";
import { Badge, statusBadge } from "#templates/components/badge.tsx";

export type DebugPageState = {
  appleWallet: {
    dbConfigured: boolean;
    envConfigured: boolean;
    passTypeId: string;
    source: string;
    certValidation: {
      signingCert: string;
      signingKey: string;
      wwdrCert: string;
    };
  };
  googleWallet: {
    dbConfigured: boolean;
    envConfigured: boolean;
    issuerId: string;
    source: string;
    privateKeyValid: string;
  };
  payment: {
    provider: string;
    keyConfigured: boolean;
    webhookConfigured: boolean;
    mode: string;
  };
  site: {
    publicSite: boolean;
    publicApi: boolean;
    contactForm: boolean;
    spamProtection: boolean;
    country: string;
    currency: string;
    timezone: string;
    bookingFee: string;
  };
  availability: {
    state: "active" | "warning" | "readonly";
    cutoff: string;
    renewalConfigured: boolean;
    serverTime: string;
  };
  email: {
    provider: string;
    apiKeyConfigured: boolean;
    fromAddress: string;
    hostProvider: string;
  };
  ntfy: {
    configured: boolean;
  };
  bunny: {
    storageBackend: "bunny" | "local" | "none";
    cdnEnabled: boolean;
    cdnHostname: string;
    customDomain: string;
    dnsEnabled: boolean;
    subdomainSuffix: string;
    registeredSubdomain: string;
  };
  database: {
    hostConfigured: boolean;
    schemaInSync: boolean;
    schemaHash: string;
  };
  build: {
    timestamp: string;
    commit: string;
  };
  runtime: RuntimeInfo;
  domain: string;
  limits: typeof LIMIT_ENTRIES;
  prune: {
    addresses: string;
    payments: string;
    sessions: string;
    strings: string;
    logins: string;
  };
  theme: Theme;
};

/** A two-column label/value row in a debug section table. */
const Row = ({
  label,
  value,
}: {
  label: string;
  value: Child;
}): JSX.Element => (
  <tr>
    <td>{label}</td>
    <td>{value}</td>
  </tr>
);

/** A row declared as data: a label plus a value (string or JSX). */
type RowSpec = { label: string; value: Child };

/** Render a list of row specs as <tr><td>…</td><td>…</td></tr> rows. */
const renderRows = (rows: readonly RowSpec[]): JSX.Element[] =>
  rows.map((r) => <Row label={r.label} value={r.value} />);

/** A row spec factory for the common "label + Configured/Not configured badge"
 *  shape used throughout the debug sections. */
const statusRow = (label: string, ok: boolean): RowSpec => ({
  label,
  value: statusBadge(ok, t("common.configured"), t("common.not_configured")),
});

/** The article/h2/table-scroll scaffolding shared by every debug section. */
const DebugSection = ({
  title,
  rows,
}: {
  title: string;
  rows: readonly RowSpec[];
}): JSX.Element => (
  <article>
    <h2>{title}</h2>
    <div class="table-scroll">
      <table>
        <tbody>{renderRows(rows)}</tbody>
      </table>
    </div>
  </article>
);

/** A debug section that opens with a prose intro (h2 + paragraph) before the
 *  table-scroll/table. Curried: specialise the prose side, then pass the table
 *  content (thead/tbody) at the call site. Used by the limits and prune
 *  sections, which share the opener boilerplate via this factory. */
const proseTableSection =
  (title: string, intro: Child): ((children: Child) => JSX.Element) =>
  (children) => (
    <article>
      <div class="prose">
        <h2>{title}</h2>
        <p>{intro}</p>
      </div>
      <div class="table-scroll">
        <table>{children}</table>
      </div>
    </article>
  );

const BuildSection = ({
  build,
}: {
  build: DebugPageState["build"];
}): JSX.Element =>
  DebugSection({
    rows: [
      { label: t("debug.field.timestamp"), value: build.timestamp || "—" },
      { label: t("debug.field.commit"), value: build.commit || "—" },
    ],
    title: t("debug.section.build"),
  });

const RuntimeSection = ({
  runtime,
}: {
  runtime: DebugPageState["runtime"];
}): JSX.Element =>
  DebugSection({
    rows: [
      { label: t("debug.field.host_runtime"), value: runtime.runtime },
      {
        label: t("debug.field.deno_version"),
        value: runtime.denoVersion || "—",
      },
      { label: t("debug.field.v8_version"), value: runtime.v8Version || "—" },
      {
        label: t("debug.field.typescript_version"),
        value: runtime.typescriptVersion || "—",
      },
      {
        label: t("debug.field.node_compatibility"),
        value: runtime.nodeCompatVersion || "—",
      },
      {
        label: t("debug.field.os_architecture"),
        value: `${runtime.os || "—"}${runtime.arch ? ` / ${runtime.arch}` : ""}`,
      },
      { label: t("debug.field.user_agent"), value: runtime.userAgent || "—" },
    ],
    title: t("debug.section.runtime"),
  });

/** The three config-source rows shared by both wallet sections. */
const walletConfigRows = (w: {
  dbConfigured: boolean;
  envConfigured: boolean;
  source: string;
}): RowSpec[] => [
  statusRow(t("debug.field.db_config"), w.dbConfigured),
  statusRow(t("debug.field.env_var_config"), w.envConfigured),
  {
    label: t("debug.field.active_source"),
    value: w.source || t("common.none"),
  },
];

const AppleWalletSection = ({
  appleWallet,
}: {
  appleWallet: DebugPageState["appleWallet"];
}): JSX.Element =>
  DebugSection({
    rows: [
      ...walletConfigRows(appleWallet),
      {
        label: t("debug.field.pass_type_id"),
        value: appleWallet.passTypeId || "—",
      },
      {
        label: t("debug.field.signing_certificate"),
        value: appleWallet.certValidation.signingCert,
      },
      {
        label: t("debug.field.signing_key"),
        value: appleWallet.certValidation.signingKey,
      },
      {
        label: t("debug.field.wwdr_certificate"),
        value: appleWallet.certValidation.wwdrCert,
      },
    ],
    title: t("debug.section.apple_wallet"),
  });

const GoogleWalletSection = ({
  googleWallet,
}: {
  googleWallet: DebugPageState["googleWallet"];
}): JSX.Element =>
  DebugSection({
    rows: [
      ...walletConfigRows(googleWallet),
      {
        label: t("debug.field.issuer_id"),
        value: googleWallet.issuerId || "—",
      },
      {
        label: t("debug.field.private_key"),
        value: googleWallet.privateKeyValid,
      },
    ],
    title: t("debug.section.google_wallet"),
  });

const PaymentsSection = ({
  payment,
}: {
  payment: DebugPageState["payment"];
}): JSX.Element =>
  DebugSection({
    rows: [
      {
        label: t("debug.field.provider"),
        value: payment.provider || t("common.none"),
      },
      { label: t("debug.field.mode"), value: payment.mode || "—" },
      statusRow(t("debug.field.api_key"), payment.keyConfigured),
      statusRow(t("debug.field.webhook"), payment.webhookConfigured),
    ],
    title: t("debug.section.payments"),
  });

const EmailSection = ({
  email,
}: {
  email: DebugPageState["email"];
}): JSX.Element =>
  DebugSection({
    rows: [
      {
        label: t("debug.field.provider_db"),
        value: email.provider || t("common.none"),
      },
      statusRow(t("debug.field.api_key"), email.apiKeyConfigured),
      { label: t("debug.field.from_address"), value: email.fromAddress || "—" },
      {
        label: t("debug.field.host_provider_env"),
        value: email.hostProvider || t("common.none"),
      },
    ],
    title: t("common.email"),
  });

const NtfySection = ({ ntfy }: { ntfy: DebugPageState["ntfy"] }): JSX.Element =>
  DebugSection({
    rows: [statusRow(t("debug.field.ntfy_url"), ntfy.configured)],
    title: t("debug.section.notifications"),
  });

const SiteSection = ({ site }: { site: DebugPageState["site"] }): JSX.Element =>
  DebugSection({
    rows: [
      {
        label: t("debug.field.public_site"),
        value: statusBadge(site.publicSite, "Visible", "Hidden"),
      },
      {
        label: t("debug.field.public_api"),
        value: statusBadge(site.publicApi, "Enabled", "Disabled"),
      },
      {
        label: t("debug.field.contact_form"),
        value: statusBadge(site.contactForm, "Enabled", "Disabled"),
      },
      statusRow(t("debug.field.spam_protection"), site.spamProtection),
      { label: t("debug.field.country"), value: site.country || "—" },
      { label: t("debug.field.currency"), value: site.currency || "—" },
      { label: t("debug.field.timezone"), value: site.timezone || "—" },
      { label: t("debug.field.booking_fee"), value: `${site.bookingFee}%` },
    ],
    title: t("debug.section.site"),
  });

const AvailabilityStateBadge = ({
  state,
}: {
  state: DebugPageState["availability"]["state"];
}): JSX.Element => {
  if (state === "readonly") return <Badge variant="missing">Read-only</Badge>;
  if (state === "warning") {
    return <Badge variant="missing">Expiring soon</Badge>;
  }
  return <Badge variant="ok">Active</Badge>;
};

const AvailabilitySection = ({
  availability,
}: {
  availability: DebugPageState["availability"];
}): JSX.Element =>
  DebugSection({
    rows: [
      {
        label: t("debug.field.write_access"),
        value: <AvailabilityStateBadge state={availability.state} />,
      },
      {
        label: t("debug.field.read_only_from"),
        value: availability.cutoff || "—",
      },
      statusRow(t("debug.field.renewal_url"), availability.renewalConfigured),
      {
        label: t("debug.field.server_time_utc"),
        value: availability.serverTime,
      },
    ],
    title: t("debug.section.availability"),
  });

const StorageBackendBadge = ({
  backend,
}: {
  backend: DebugPageState["bunny"]["storageBackend"];
}): JSX.Element => {
  if (backend === "bunny") return <Badge variant="ok">Bunny CDN</Badge>;
  if (backend === "local") {
    return <Badge variant="ok">Local filesystem</Badge>;
  }
  return <Badge variant="missing">Not configured</Badge>;
};

const BunnySection = ({
  bunny,
}: {
  bunny: DebugPageState["bunny"];
}): JSX.Element =>
  DebugSection({
    rows: [
      {
        label: t("debug.field.file_storage_images"),
        value: <StorageBackendBadge backend={bunny.storageBackend} />,
      },
      statusRow(t("debug.field.cdn_management"), bunny.cdnEnabled),
      { label: t("debug.field.cdn_hostname"), value: bunny.cdnHostname || "—" },
      {
        label: t("debug.field.custom_domain"),
        value: bunny.customDomain || "—",
      },
      statusRow(t("debug.field.dns_subdomain"), bunny.dnsEnabled),
      {
        label: t("debug.field.subdomain_suffix"),
        value: bunny.subdomainSuffix || "—",
      },
      {
        label: t("debug.field.registered_subdomain"),
        value: bunny.registeredSubdomain || "—",
      },
    ],
    title: t("debug.section.bunny"),
  });

const DatabaseDomainSection = ({
  database,
  domain,
}: {
  database: DebugPageState["database"];
  domain: string;
}): JSX.Element =>
  DebugSection({
    rows: [
      statusRow("DB_URL", database.hostConfigured),
      { label: t("debug.field.effective_domain"), value: domain },
      {
        label: t("debug.field.schema_status"),
        value: statusBadge(database.schemaInSync, "Up to date", "Out of sync"),
      },
      {
        label: t("debug.field.schema_hash"),
        value: <code>{database.schemaHash}</code>,
      },
    ],
    title: t("debug.section.database_domain"),
  });

const LimitValueCell = ({
  limit,
}: {
  limit: DebugPageState["limits"][number];
}): JSX.Element =>
  limit.current === limit.defaultValue ? (
    <span>{formatLimitValue(limit.current, limit.unit)}</span>
  ) : (
    <strong>
      {formatLimitValue(limit.current, limit.unit)} {t("debug.overridden")}
    </strong>
  );

const LimitsSection = ({
  limits,
}: {
  limits: DebugPageState["limits"];
}): JSX.Element =>
  proseTableSection(
    t("debug.section.limits"),
    t("debug.limits_hint"),
  )(
    <>
      <thead>
        <tr>
          <th>{t("debug.col.setting")}</th>
          <th>{t("debug.col.env_var")}</th>
          <th>{t("debug.col.default")}</th>
          <th>{t("debug.col.current")}</th>
        </tr>
      </thead>
      <tbody>
        {limits.map((l) => (
          <tr>
            <td>{l.label}</td>
            <td>
              <code>{l.envKey}</code>
            </td>
            <td>{formatLimitValue(l.defaultValue, l.unit)}</td>
            <td>
              <LimitValueCell limit={l} />
            </td>
          </tr>
        ))}
      </tbody>
    </>,
  );

const PruneSection = ({
  prune,
}: {
  prune: DebugPageState["prune"];
}): JSX.Element =>
  proseTableSection(
    t("debug.section.database_pruning"),
    <>
      Automatic cleanup of short-lived rows. Runs in the background on incoming
      requests; frequency controlled by <code>PRUNE_INTERVAL_HOURS</code>.
    </>,
  )(
    <>
      <thead>
        <tr>
          <th>{t("debug.field.table")}</th>
          <th>{t("debug.field.last_pruned_utc")}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>processed_payments</td>
          <td>{prune.payments}</td>
        </tr>
        <tr>
          <td>sessions</td>
          <td>{prune.sessions}</td>
        </tr>
        <tr>
          <td>strings</td>
          <td>{prune.strings}</td>
        </tr>
        <tr>
          <td>login_attempts</td>
          <td>{prune.logins}</td>
        </tr>
        <tr>
          <td>address_cache</td>
          <td>{prune.addresses}</td>
        </tr>
      </tbody>
    </>,
  );

/**
 * Admin debug page
 */
export const adminDebugPage = (
  session: AdminSession,
  s: DebugPageState,
): string =>
  themedAdminPage(t("debug.title"), "/admin/debug")(session, s.theme)(
    <>
      <div class="prose">
        <h1>{t("debug.heading")}</h1>
        <p>{t("debug.description")}</p>
      </div>

      <BuildSection build={s.build} />
      <RuntimeSection runtime={s.runtime} />
      <SiteSection site={s.site} />
      <AvailabilitySection availability={s.availability} />
      <AppleWalletSection appleWallet={s.appleWallet} />
      <GoogleWalletSection googleWallet={s.googleWallet} />
      <PaymentsSection payment={s.payment} />
      <EmailSection email={s.email} />
      <NtfySection ntfy={s.ntfy} />
      <BunnySection bunny={s.bunny} />
      <DatabaseDomainSection database={s.database} domain={s.domain} />
      <LimitsSection limits={s.limits} />
      <PruneSection prune={s.prune} />
    </>,
  );
