/**
 * Embed Hosts form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";
/* jscpd:ignore-end */

export const EmbedHostsForm = textSettingsSection<SettingsPageState>({
  action: "/admin/settings/embed-hosts",
  description: <p>{t("settings.embed_hosts_hint")}</p>,
  footer: (
    <p>
      <small>
        Use <code>*.example.com</code> to allow all subdomains. Direct visits to
        the booking page are always allowed.
      </small>
    </p>
  ),
  getValue: (s) => s.embedHosts,
  label: t("settings.embed_hosts_label"),
  name: "embed_hosts",
  placeholder: "example.com, *.mysite.org",
  submitLabel: t("settings.save_embed_hosts"),
  title: t("settings.embed_hosts"),
  type: "text",
});
