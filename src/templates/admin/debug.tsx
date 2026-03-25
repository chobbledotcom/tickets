/**
 * Admin debug page template - shows configuration status for troubleshooting
 */

import { formatLimitValue, type LIMIT_ENTRIES } from "#lib/limits.ts";
import type { AdminSession, Theme } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
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
    storageEnabled: boolean;
    cdnEnabled: boolean;
    cdnHostname: string;
    customDomain: string;
    dnsEnabled: boolean;
    subdomainSuffix: string;
    registeredSubdomain: string;
  };
  database: {
    hostConfigured: boolean;
  };
  build: {
    timestamp: string;
    commit: string;
  };
  domain: string;
  limits: typeof LIMIT_ENTRIES;
  theme: Theme;
};

const StatusBadge = ({ ok }: { ok: boolean }): JSX.Element =>
  ok ? (
    <span class="badge-ok">Configured</span>
  ) : (
    <span class="badge-missing">Not configured</span>
  );

/**
 * Admin debug page
 */
export const adminDebugPage = (
  session: AdminSession,
  s: DebugPageState,
): string =>
  String(
    <Layout title="Debug Info" theme={s.theme}>
      <AdminNav session={session} active="/admin/settings" />

      <h1>Debug Info</h1>
      <p>
        Configuration status overview for troubleshooting. No secrets or keys
        are shown.
      </p>

      <article>
        <h2>Build</h2>
        <table>
          <tbody>
            <tr>
              <td>Timestamp</td>
              <td>{s.build.timestamp || "—"}</td>
            </tr>
            <tr>
              <td>Commit</td>
              <td>{s.build.commit || "—"}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Apple Wallet</h2>
        <table>
          <tbody>
            <tr>
              <td>DB config</td>
              <td>
                <StatusBadge ok={s.appleWallet.dbConfigured} />
              </td>
            </tr>
            <tr>
              <td>Env var config</td>
              <td>
                <StatusBadge ok={s.appleWallet.envConfigured} />
              </td>
            </tr>
            <tr>
              <td>Active source</td>
              <td>{s.appleWallet.source || "None"}</td>
            </tr>
            <tr>
              <td>Pass Type ID</td>
              <td>{s.appleWallet.passTypeId || "—"}</td>
            </tr>
            <tr>
              <td>Signing certificate</td>
              <td>{s.appleWallet.certValidation.signingCert}</td>
            </tr>
            <tr>
              <td>Signing key</td>
              <td>{s.appleWallet.certValidation.signingKey}</td>
            </tr>
            <tr>
              <td>WWDR certificate</td>
              <td>{s.appleWallet.certValidation.wwdrCert}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Google Wallet</h2>
        <table>
          <tbody>
            <tr>
              <td>DB config</td>
              <td>
                <StatusBadge ok={s.googleWallet.dbConfigured} />
              </td>
            </tr>
            <tr>
              <td>Env var config</td>
              <td>
                <StatusBadge ok={s.googleWallet.envConfigured} />
              </td>
            </tr>
            <tr>
              <td>Active source</td>
              <td>{s.googleWallet.source || "None"}</td>
            </tr>
            <tr>
              <td>Issuer ID</td>
              <td>{s.googleWallet.issuerId || "—"}</td>
            </tr>
            <tr>
              <td>Private key</td>
              <td>{s.googleWallet.privateKeyValid}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Payments</h2>
        <table>
          <tbody>
            <tr>
              <td>Provider</td>
              <td>{s.payment.provider || "None"}</td>
            </tr>
            <tr>
              <td>API key</td>
              <td>
                <StatusBadge ok={s.payment.keyConfigured} />
              </td>
            </tr>
            <tr>
              <td>Webhook</td>
              <td>
                <StatusBadge ok={s.payment.webhookConfigured} />
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Email</h2>
        <table>
          <tbody>
            <tr>
              <td>Provider (DB)</td>
              <td>{s.email.provider || "None"}</td>
            </tr>
            <tr>
              <td>API key</td>
              <td>
                <StatusBadge ok={s.email.apiKeyConfigured} />
              </td>
            </tr>
            <tr>
              <td>From address</td>
              <td>{s.email.fromAddress || "—"}</td>
            </tr>
            <tr>
              <td>Host provider (env)</td>
              <td>{s.email.hostProvider || "None"}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Notifications (ntfy)</h2>
        <table>
          <tbody>
            <tr>
              <td>NTFY URL</td>
              <td>
                <StatusBadge ok={s.ntfy.configured} />
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Bunny</h2>
        <table>
          <tbody>
            <tr>
              <td>Storage zone (images)</td>
              <td>
                <StatusBadge ok={s.bunny.storageEnabled} />
              </td>
            </tr>
            <tr>
              <td>CDN management</td>
              <td>
                <StatusBadge ok={s.bunny.cdnEnabled} />
              </td>
            </tr>
            <tr>
              <td>CDN hostname</td>
              <td>{s.bunny.cdnHostname || "—"}</td>
            </tr>
            <tr>
              <td>Custom domain</td>
              <td>{s.bunny.customDomain || "—"}</td>
            </tr>
            <tr>
              <td>DNS subdomain</td>
              <td>
                <StatusBadge ok={s.bunny.dnsEnabled} />
              </td>
            </tr>
            <tr>
              <td>Subdomain suffix</td>
              <td>{s.bunny.subdomainSuffix || "—"}</td>
            </tr>
            <tr>
              <td>Registered subdomain</td>
              <td>{s.bunny.registeredSubdomain || "—"}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Database &amp; Domain</h2>
        <table>
          <tbody>
            <tr>
              <td>DB_URL</td>
              <td>
                <StatusBadge ok={s.database.hostConfigured} />
              </td>
            </tr>
            <tr>
              <td>Effective domain</td>
              <td>{s.domain}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Limits</h2>
        <p>
          Override any limit with the corresponding environment variable. Values
          must be positive integers.
        </p>
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
            {s.limits.map((l) => (
              <tr>
                <td>{l.label}</td>
                <td>
                  <code>{l.envKey}</code>
                </td>
                <td>{formatLimitValue(l.defaultValue, l.unit)}</td>
                <td>
                  {l.current === l.defaultValue ? (
                    <span>{formatLimitValue(l.current, l.unit)}</span>
                  ) : (
                    <strong>
                      {formatLimitValue(l.current, l.unit)} (overridden)
                    </strong>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </Layout>,
  );
