/**
 * Admin debug page template - shows configuration status for troubleshooting
 */

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
    logins: string;
  };
  theme: Theme;
};

const StatusBadge = ({ ok }: { ok: boolean }): JSX.Element =>
  ok ? (
    <span class="badge-ok">Configured</span>
  ) : (
    <span class="badge-missing">Not configured</span>
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
    <h2>Build</h2>
    <table>
      <tbody>
        <tr>
          <td>Timestamp</td>
          <td>{build.timestamp || "—"}</td>
        </tr>
        <tr>
          <td>Commit</td>
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
    <h2>Runtime</h2>
    <table>
      <tbody>
        <tr>
          <td>Host runtime</td>
          <td>{runtime.runtime}</td>
        </tr>
        <tr>
          <td>Deno version</td>
          <td>{runtime.denoVersion || "—"}</td>
        </tr>
        <tr>
          <td>V8 version</td>
          <td>{runtime.v8Version || "—"}</td>
        </tr>
        <tr>
          <td>TypeScript version</td>
          <td>{runtime.typescriptVersion || "—"}</td>
        </tr>
        <tr>
          <td>Node compatibility</td>
          <td>{runtime.nodeCompatVersion || "—"}</td>
        </tr>
        <tr>
          <td>OS / architecture</td>
          <td>
            {runtime.os || "—"}
            {runtime.arch ? ` / ${runtime.arch}` : ""}
          </td>
        </tr>
        <tr>
          <td>User agent</td>
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
    <h2>Apple Wallet</h2>
    <table>
      <tbody>
        <tr>
          <td>DB config</td>
          <td>
            <StatusBadge ok={appleWallet.dbConfigured} />
          </td>
        </tr>
        <tr>
          <td>Env var config</td>
          <td>
            <StatusBadge ok={appleWallet.envConfigured} />
          </td>
        </tr>
        <tr>
          <td>Active source</td>
          <td>{appleWallet.source || "None"}</td>
        </tr>
        <tr>
          <td>Pass Type ID</td>
          <td>{appleWallet.passTypeId || "—"}</td>
        </tr>
        <tr>
          <td>Signing certificate</td>
          <td>{appleWallet.certValidation.signingCert}</td>
        </tr>
        <tr>
          <td>Signing key</td>
          <td>{appleWallet.certValidation.signingKey}</td>
        </tr>
        <tr>
          <td>WWDR certificate</td>
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
    <h2>Google Wallet</h2>
    <table>
      <tbody>
        <tr>
          <td>DB config</td>
          <td>
            <StatusBadge ok={googleWallet.dbConfigured} />
          </td>
        </tr>
        <tr>
          <td>Env var config</td>
          <td>
            <StatusBadge ok={googleWallet.envConfigured} />
          </td>
        </tr>
        <tr>
          <td>Active source</td>
          <td>{googleWallet.source || "None"}</td>
        </tr>
        <tr>
          <td>Issuer ID</td>
          <td>{googleWallet.issuerId || "—"}</td>
        </tr>
        <tr>
          <td>Private key</td>
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
    <h2>Payments</h2>
    <table>
      <tbody>
        <tr>
          <td>Provider</td>
          <td>{payment.provider || "None"}</td>
        </tr>
        <tr>
          <td>Mode</td>
          <td>{payment.mode || "—"}</td>
        </tr>
        <tr>
          <td>API key</td>
          <td>
            <StatusBadge ok={payment.keyConfigured} />
          </td>
        </tr>
        <tr>
          <td>Webhook</td>
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
    <h2>Email</h2>
    <table>
      <tbody>
        <tr>
          <td>Provider (DB)</td>
          <td>{email.provider || "None"}</td>
        </tr>
        <tr>
          <td>API key</td>
          <td>
            <StatusBadge ok={email.apiKeyConfigured} />
          </td>
        </tr>
        <tr>
          <td>From address</td>
          <td>{email.fromAddress || "—"}</td>
        </tr>
        <tr>
          <td>Host provider (env)</td>
          <td>{email.hostProvider || "None"}</td>
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
    <h2>Notifications (ntfy)</h2>
    <table>
      <tbody>
        <tr>
          <td>NTFY URL</td>
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
    <h2>Site</h2>
    <table>
      <tbody>
        <tr>
          <td>Public site</td>
          <td>
            <OnOffBadge
              offLabel="Hidden"
              on={site.publicSite}
              onLabel="Visible"
            />
          </td>
        </tr>
        <tr>
          <td>Public API</td>
          <td>
            <OnOffBadge
              offLabel="Disabled"
              on={site.publicApi}
              onLabel="Enabled"
            />
          </td>
        </tr>
        <tr>
          <td>Contact form</td>
          <td>
            <OnOffBadge
              offLabel="Disabled"
              on={site.contactForm}
              onLabel="Enabled"
            />
          </td>
        </tr>
        <tr>
          <td>Spam protection</td>
          <td>
            <StatusBadge ok={site.spamProtection} />
          </td>
        </tr>
        <tr>
          <td>Country</td>
          <td>{site.country || "—"}</td>
        </tr>
        <tr>
          <td>Currency</td>
          <td>{site.currency || "—"}</td>
        </tr>
        <tr>
          <td>Timezone</td>
          <td>{site.timezone || "—"}</td>
        </tr>
        <tr>
          <td>Booking fee</td>
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
    <h2>Availability</h2>
    <table>
      <tbody>
        <tr>
          <td>Write access</td>
          <td>
            <AvailabilityStateBadge state={availability.state} />
          </td>
        </tr>
        <tr>
          <td>Read-only from</td>
          <td>{availability.cutoff || "—"}</td>
        </tr>
        <tr>
          <td>Renewal URL</td>
          <td>
            <StatusBadge ok={availability.renewalConfigured} />
          </td>
        </tr>
        <tr>
          <td>Server time (UTC)</td>
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
    <h2>Bunny</h2>
    <table>
      <tbody>
        <tr>
          <td>File storage (images)</td>
          <td>
            <StorageBackendBadge backend={bunny.storageBackend} />
          </td>
        </tr>
        <tr>
          <td>CDN management</td>
          <td>
            <StatusBadge ok={bunny.cdnEnabled} />
          </td>
        </tr>
        <tr>
          <td>CDN hostname</td>
          <td>{bunny.cdnHostname || "—"}</td>
        </tr>
        <tr>
          <td>Custom domain</td>
          <td>{bunny.customDomain || "—"}</td>
        </tr>
        <tr>
          <td>DNS subdomain</td>
          <td>
            <StatusBadge ok={bunny.dnsEnabled} />
          </td>
        </tr>
        <tr>
          <td>Subdomain suffix</td>
          <td>{bunny.subdomainSuffix || "—"}</td>
        </tr>
        <tr>
          <td>Registered subdomain</td>
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
    <h2>Database &amp; Domain</h2>
    <table>
      <tbody>
        <tr>
          <td>DB_URL</td>
          <td>
            <StatusBadge ok={database.hostConfigured} />
          </td>
        </tr>
        <tr>
          <td>Effective domain</td>
          <td>{domain}</td>
        </tr>
        <tr>
          <td>Schema status</td>
          <td>
            <OnOffBadge
              offLabel="Out of sync"
              on={database.schemaInSync}
              onLabel="Up to date"
            />
          </td>
        </tr>
        <tr>
          <td>Schema hash</td>
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
    <strong>{formatLimitValue(limit.current, limit.unit)} (overridden)</strong>
  );

const LimitsSection = ({
  limits,
}: {
  limits: DebugPageState["limits"];
}): JSX.Element => (
  <article>
    <div class="prose">
      <h2>Limits</h2>
      <p>
        Override any limit with the corresponding environment variable. Values
        must be positive integers.
      </p>
    </div>
    <table>
      <thead>
        <tr>
          <th>Setting</th>
          <th>Env var</th>
          <th>Default</th>
          <th>Current</th>
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
      <h2>Database pruning</h2>
      <p>
        Automatic cleanup of short-lived rows. Runs in the background on
        incoming requests; frequency controlled by{" "}
        <code>PRUNE_INTERVAL_HOURS</code>.
      </p>
    </div>
    <table>
      <thead>
        <tr>
          <th>Table</th>
          <th>Last pruned (UTC)</th>
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
    <Layout theme={s.theme} title="Debug Info">
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <div class="prose">
        <h1>Debug Info</h1>
        <p>
          Configuration status overview for troubleshooting. No secrets or keys
          are shown.
        </p>
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
