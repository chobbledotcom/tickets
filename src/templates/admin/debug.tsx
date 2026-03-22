/**
 * Admin debug page template - shows configuration status for troubleshooting
 */

import { formatLimitValue, type LIMIT_ENTRIES } from "#lib/limits.ts";
import type { AdminSession, Theme } from "#lib/types.ts";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";
import { t } from "#i18n";

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
    <span class="badge-ok">{t("common.configured")}</span>
  ) : (
    <span class="badge-missing">{t("common.not_configured")}</span>
  );

/**
 * Admin debug page
 */
export const adminDebugPage = (
  session: AdminSession,
  s: DebugPageState,
): string =>
  String(
    <Layout title={t("debug.title")} theme={s.theme} mainClass="stack-xl">
      <AdminNav session={session} active="/admin/settings" />
      <Breadcrumb href="/admin/settings" label="Settings" />

      <h1>{t("debug.heading")}</h1>
      <p>
        {t("debug.description")}
      </p>

      <article>
        <h2>{t("debug.section.build")}</h2>
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
        <h2>{t("debug.section.apple_wallet")}</h2>
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
              <td>{s.appleWallet.source || t("common.none")}</td>
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
        <h2>{t("debug.section.google_wallet")}</h2>
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
              <td>{s.googleWallet.source || t("common.none")}</td>
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
        <h2>{t("debug.section.payments")}</h2>
        <table>
          <tbody>
            <tr>
              <td>Provider</td>
              <td>{s.payment.provider || t("common.none")}</td>
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
        <h2>{t("debug.section.email")}</h2>
        <table>
          <tbody>
            <tr>
              <td>Provider (DB)</td>
              <td>{s.email.provider || t("common.none")}</td>
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
              <td>{s.email.hostProvider || t("common.none")}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>{t("debug.section.notifications")}</h2>
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
        <h2>{t("debug.section.bunny_storage")}</h2>
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
        <h2>{t("debug.section.bunny_cdn")}</h2>
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
        <h2>{t("debug.section.database")}</h2>
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
        <h2>{t("debug.section.domain")}</h2>
        <table>
          <tbody>
            <tr>
              <td>ALLOWED_DOMAIN</td>
              <td>{s.domain}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article>
        <h2>{t("debug.section.limits")}</h2>
        <p>
          {t("debug.limits_hint")}
        </p>
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
                      {formatLimitValue(l.current, l.unit)} {t("debug.overridden")}
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
