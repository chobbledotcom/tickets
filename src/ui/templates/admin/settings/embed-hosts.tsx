/**
 * Embed Hosts form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

export const EmbedHostsForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/embed-hosts"
    description={<p>{t("settings.embed_hosts_hint")}</p>}
    submitLabel={t("settings.save_embed_hosts")}
    title={t("settings.embed_hosts")}
  >
    <TextField
      label={t("settings.embed_hosts_label")}
      name="embed_hosts"
      placeholder="example.com, *.mysite.org"
      type="text"
      value={s.embedHosts}
    />
    <p>
      <small>
        Use <code>*.example.com</code> to allow all subdomains. Direct visits to
        the booking page are always allowed.
      </small>
    </p>
  </SettingsSection>
);
