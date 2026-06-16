/**
 * Embed Hosts form for settings
 */

import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const EmbedHostsForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/embed-hosts"
    description={<p>{t("settings.embed_hosts_hint")}</p>}
    submitLabel={t("settings.save_embed_hosts")}
    title={t("settings.embed_hosts")}
  >
    <label>
      {t("settings.embed_hosts_label")}
      <input
        autocomplete="off"
        name="embed_hosts"
        placeholder="example.com, *.mysite.org"
        type="text"
        value={s.embedHosts}
      />
    </label>
    <p>
      <small>
        Use <code>*.example.com</code> to allow all subdomains. Direct visits to
        the booking page are always allowed.
      </small>
    </p>
  </SettingsSection>
);
