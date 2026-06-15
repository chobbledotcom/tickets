/**
 * Embed Hosts form for settings
 */

import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const EmbedHostsForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/embed-hosts"
    description={
      <p>
        Restrict which websites can embed your booking forms in an iframe. Leave
        blank to allow embedding from any site.
      </p>
    }
    id="settings-embed-hosts"
    submitLabel="Save Embed Hosts"
    title="Only allow embedding on these hosts"
  >
    <label>
      Hosts (comma-separated)
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
