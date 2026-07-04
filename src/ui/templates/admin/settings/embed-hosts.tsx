/**
 * Embed Hosts form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";
/* jscpd:ignore-end */

export const EmbedHostsForm = textSettingsSection<SettingsPageState>((s) => ({
  action: "/admin/settings/embed-hosts",
  description: <p>{t("settings.embed_hosts_hint")}</p>,
  footer: (
    <p>
      <small>{t("settings.embed_hosts_wildcard_hint")}</small>
    </p>
  ),
  label: t("settings.embed_hosts_label"),
  name: "embed_hosts",
  placeholder: t("settings.embed_hosts_placeholder"),
  submitLabel: t("settings.save_embed_hosts"),
  title: t("settings.embed_hosts"),
  type: "text",
  value: s.embedHosts,
}));
