/**
 * Admin debug page template - shows configuration status for troubleshooting
 */

import { t } from "#i18n";
import { formatLimitValue, type LIMIT_ENTRIES } from "#shared/limits.ts";
import type { RuntimeInfo } from "#shared/runtime.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

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
    payments: string;
    sessions: string;
    strings: string;
    logins: string;
  };
  theme: Theme;
};

const StatusBadge = ({ ok }: { ok: boolean }): JSX.Element =>
  ok ? (
    <span class="badge-ok">{t("common.configured")}</span>
  ) : (
    <span class="badge-missing">{t("common.not_configured")}</span>
  );

/** Badge with caller-chosen labels for a two-state (on/off) value. */
const OnOffBadge = ({
  on,
  onLabel,
  offLabel,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
}): JSX.Element =>
  on ? (
    <span class="badge-ok">{onLabel}</span>
  ) : (
    <span class="badge-missing">{offLabel}</span>
  );

const BuildSection = ({
  build,
}: {
  build: DebugPageState["build"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.build")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.timestamp")}</td>
          <td>{build.timestamp || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.commit")}</td>
          <td>{build.commit || "—"}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const RuntimeSection = ({
  runtime,
}: {
  runtime: DebugPageState["runtime"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.runtime")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.host_runtime")}</td>
          <td>{runtime.runtime}</td>
        </tr>
        <tr>
          <td>{t("debug.field.deno_version")}</td>
          <td>{runtime.denoVersion || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.v8_version")}</td>
          <td>{runtime.v8Version || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.typescript_version")}</td>
          <td>{runtime.typescriptVersion || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.node_compatibility")}</td>
          <td>{runtime.nodeCompatVersion || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.os_architecture")}</td>
          <td>
            {runtime.os || "—"}
            {runtime.arch ? ` / ${runtime.arch}` : ""}
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.user_agent")}</td>
          <td>{runtime.userAgent || "—"}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const AppleWalletSection = ({
  appleWallet,
}: {
  appleWallet: DebugPageState["appleWallet"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.apple_wallet")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.db_config")}</td>
          <td>
            <StatusBadge ok={appleWallet.dbConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.env_var_config")}</td>
          <td>
            <StatusBadge ok={appleWallet.envConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.active_source")}</td>
          <td>{appleWallet.source || t("common.none")}</td>
        </tr>
        <tr>
          <td>{t("debug.field.pass_type_id")}</td>
          <td>{appleWallet.passTypeId || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.signing_certificate")}</td>
          <td>{appleWallet.certValidation.signingCert}</td>
        </tr>
        <tr>
          <td>{t("debug.field.signing_key")}</td>
          <td>{appleWallet.certValidation.signingKey}</td>
        </tr>
        <tr>
          <td>{t("debug.field.wwdr_certificate")}</td>
          <td>{appleWallet.certValidation.wwdrCert}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const GoogleWalletSection = ({
  googleWallet,
}: {
  googleWallet: DebugPageState["googleWallet"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.google_wallet")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.db_config")}</td>
          <td>
            <StatusBadge ok={googleWallet.dbConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.env_var_config")}</td>
          <td>
            <StatusBadge ok={googleWallet.envConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.active_source")}</td>
          <td>{googleWallet.source || t("common.none")}</td>
        </tr>
        <tr>
          <td>{t("debug.field.issuer_id")}</td>
          <td>{googleWallet.issuerId || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.private_key")}</td>
          <td>{googleWallet.privateKeyValid}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const PaymentsSection = ({
  payment,
}: {
  payment: DebugPageState["payment"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.payments")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.provider")}</td>
          <td>{payment.provider || t("common.none")}</td>
        </tr>
        <tr>
          <td>{t("debug.field.mode")}</td>
          <td>{payment.mode || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.api_key")}</td>
          <td>
            <StatusBadge ok={payment.keyConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.webhook")}</td>
          <td>
            <StatusBadge ok={payment.webhookConfigured} />
          </td>
        </tr>
      </tbody>
    </table>
  </article>
);

const EmailSection = ({
  email,
}: {
  email: DebugPageState["email"];
}): JSX.Element => (
  <article>
    <h2>{t("common.email")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.provider_db")}</td>
          <td>{email.provider || t("common.none")}</td>
        </tr>
        <tr>
          <td>{t("debug.field.api_key")}</td>
          <td>
            <StatusBadge ok={email.apiKeyConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.from_address")}</td>
          <td>{email.fromAddress || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.host_provider_env")}</td>
          <td>{email.hostProvider || t("common.none")}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const NtfySection = ({
  ntfy,
}: {
  ntfy: DebugPageState["ntfy"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.notifications")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.ntfy_url")}</td>
          <td>
            <StatusBadge ok={ntfy.configured} />
          </td>
        </tr>
      </tbody>
    </table>
  </article>
);

const SiteSection = ({
  site,
}: {
  site: DebugPageState["site"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.site")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.public_site")}</td>
          <td>
            <OnOffBadge
              offLabel="Hidden"
              on={site.publicSite}
              onLabel="Visible"
            />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.public_api")}</td>
          <td>
            <OnOffBadge
              offLabel="Disabled"
              on={site.publicApi}
              onLabel="Enabled"
            />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.contact_form")}</td>
          <td>
            <OnOffBadge
              offLabel="Disabled"
              on={site.contactForm}
              onLabel="Enabled"
            />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.spam_protection")}</td>
          <td>
            <StatusBadge ok={site.spamProtection} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.country")}</td>
          <td>{site.country || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.currency")}</td>
          <td>{site.currency || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.timezone")}</td>
          <td>{site.timezone || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.booking_fee")}</td>
          <td>{site.bookingFee}%</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const AvailabilityStateBadge = ({
  state,
}: {
  state: DebugPageState["availability"]["state"];
}): JSX.Element => {
  if (state === "readonly") {
    return <span class="badge-missing">Read-only</span>;
  }
  if (state === "warning") {
    return <span class="badge-missing">Expiring soon</span>;
  }
  return <span class="badge-ok">Active</span>;
};

const AvailabilitySection = ({
  availability,
}: {
  availability: DebugPageState["availability"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.availability")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.write_access")}</td>
          <td>
            <AvailabilityStateBadge state={availability.state} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.read_only_from")}</td>
          <td>{availability.cutoff || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.renewal_url")}</td>
          <td>
            <StatusBadge ok={availability.renewalConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.server_time_utc")}</td>
          <td>{availability.serverTime}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const StorageBackendBadge = ({
  backend,
}: {
  backend: DebugPageState["bunny"]["storageBackend"];
}): JSX.Element => {
  if (backend === "bunny") return <span class="badge-ok">Bunny CDN</span>;
  if (backend === "local") {
    return <span class="badge-ok">Local filesystem</span>;
  }
  return <span class="badge-missing">Not configured</span>;
};

const BunnySection = ({
  bunny,
}: {
  bunny: DebugPageState["bunny"];
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.bunny")}</h2>
    <table>
      <tbody>
        <tr>
          <td>{t("debug.field.file_storage_images")}</td>
          <td>
            <StorageBackendBadge backend={bunny.storageBackend} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.cdn_management")}</td>
          <td>
            <StatusBadge ok={bunny.cdnEnabled} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.cdn_hostname")}</td>
          <td>{bunny.cdnHostname || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.custom_domain")}</td>
          <td>{bunny.customDomain || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.dns_subdomain")}</td>
          <td>
            <StatusBadge ok={bunny.dnsEnabled} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.subdomain_suffix")}</td>
          <td>{bunny.subdomainSuffix || "—"}</td>
        </tr>
        <tr>
          <td>{t("debug.field.registered_subdomain")}</td>
          <td>{bunny.registeredSubdomain || "—"}</td>
        </tr>
      </tbody>
    </table>
  </article>
);

const DatabaseDomainSection = ({
  database,
  domain,
}: {
  database: DebugPageState["database"];
  domain: string;
}): JSX.Element => (
  <article>
    <h2>{t("debug.section.database_domain")}</h2>
    <table>
      <tbody>
        <tr>
          <td>DB_URL</td>
          <td>
            <StatusBadge ok={database.hostConfigured} />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.effective_domain")}</td>
          <td>{domain}</td>
        </tr>
        <tr>
          <td>{t("debug.field.schema_status")}</td>
          <td>
            <OnOffBadge
              offLabel="Out of sync"
              on={database.schemaInSync}
              onLabel="Up to date"
            />
          </td>
        </tr>
        <tr>
          <td>{t("debug.field.schema_hash")}</td>
          <td>
            <code>{database.schemaHash}</code>
          </td>
        </tr>
      </tbody>
    </table>
  </article>
);

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
}): JSX.Element => (
  <article>
    <div class="prose">
      <h2>{t("debug.section.limits")}</h2>
      <p>{t("debug.limits_hint")}</p>
    </div>
    <table>
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
    </table>
  </article>
);

const PruneSection = ({
  prune,
}: {
  prune: DebugPageState["prune"];
}): JSX.Element => (
  <article>
    <div class="prose">
      <h2>{t("debug.section.database_pruning")}</h2>
      <p>
        Automatic cleanup of short-lived rows. Runs in the background on
        incoming requests; frequency controlled by{" "}
        <code>PRUNE_INTERVAL_HOURS</code>.
      </p>
    </div>
    <table>
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
      </tbody>
    </table>
  </article>
);

/**
 * Admin debug page
 */
export const adminDebugPage = (
  session: AdminSession,
  s: DebugPageState,
): string =>
  String(
    <Layout theme={s.theme} title={t("debug.title")}>
      <AdminNav active="/admin/settings" session={session}>
        <SettingsSubNav />
      </AdminNav>
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
    </Layout>,
  );
