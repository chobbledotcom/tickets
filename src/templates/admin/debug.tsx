/**
 * Admin debug page template - shows configuration status for troubleshooting
 */

import type { AdminSession } from "#lib/types.ts";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type DebugPageState = {
  appleWallet: {
    dbConfigured: boolean;
    envConfigured: boolean;
    passTypeId: string;
    source: string;
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
  storage: {
    enabled: boolean;
  };
  bunnyCdn: {
    enabled: boolean;
    cdnHostname: string;
    customDomain: string;
  };
  database: {
    hostConfigured: boolean;
  };
  domain: string;
  theme: string;
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
      <Breadcrumb href="/admin/settings" label="Settings" />

      <h1>Debug Info</h1>
      <p>
        Configuration status overview for troubleshooting. No secrets or keys
        are shown.
      </p>

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
        <h2>Bunny Storage (images)</h2>
        <table>
          <tbody>
            <tr>
              <td>Storage zone</td>
              <td>
                <StatusBadge ok={s.storage.enabled} />
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Bunny CDN</h2>
        <table>
          <tbody>
            <tr>
              <td>CDN management</td>
              <td>
                <StatusBadge ok={s.bunnyCdn.enabled} />
              </td>
            </tr>
            <tr>
              <td>CDN hostname</td>
              <td>{s.bunnyCdn.cdnHostname || "—"}</td>
            </tr>
            <tr>
              <td>Custom domain</td>
              <td>{s.bunnyCdn.customDomain || "—"}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Database</h2>
        <table>
          <tbody>
            <tr>
              <td>DB_URL</td>
              <td>
                <StatusBadge ok={s.database.hostConfigured} />
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>Domain</h2>
        <table>
          <tbody>
            <tr>
              <td>ALLOWED_DOMAIN</td>
              <td>{s.domain}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </Layout>,
  );
