/**
 * Embed Hosts form for settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const EmbedHostsForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/embed-hosts" id="settings-embed-hosts">
    <h2>Only allow embedding on these hosts</h2>
    <p>
      Restrict which websites can embed your booking forms in an iframe. Leave
      blank to allow embedding from any site.
    </p>
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
    <button type="submit">Save Embed Hosts</button>
  </CsrfForm>
);
