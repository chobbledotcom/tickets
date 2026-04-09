/**
 * Host Subdomain form for advanced settings
 */

import type { SafeHtml } from "#jsx/jsx-runtime";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

const SubdomainIntroProse = (): SafeHtml => (
  <div class="prose">
    <p>
      You can choose a prettier domain name for your tickets site. Enter a
      subdomain into the box below to preview the full URL &mdash; you can
      change your mind before saving, but once set this cannot be changed.{" "}
      <a href="/admin/guide#host-subdomain">Learn more</a>.
    </p>
  </div>
);

const SubdomainFormContent = (s: AdvancedSettingsPageState): SafeHtml => {
  if (s.bunnySubdomain) {
    return (
      <>
        <p>
          Your site is available at{" "}
          <a href={`https://${s.bunnySubdomain}`}>
            <strong>{s.bunnySubdomain}</strong>
          </a>
          . {!s.customDomain && "You can also set a custom domain below."}
        </p>
        <p>
          <small>This subdomain is permanent and cannot be changed.</small>
        </p>
      </>
    );
  }
  if (s.subdomainPreview) {
    return (
      <>
        <SubdomainIntroProse />
        <p>
          <strong>{s.subdomainPreviewFullDomain}</strong> is available.
        </p>
        <input type="hidden" name="subdomain" value={s.subdomainPreview} />
        <label>
          <input type="checkbox" name="save" value="1" /> Confirm registration
          (cannot be undone)
        </label>
        <footer>
          <button type="submit">Register Subdomain</button>
          <a
            href="/admin/settings-advanced#settings-host-subdomain"
            class="secondary"
          >
            <strong>Cancel</strong>
          </a>
        </footer>
      </>
    );
  }
  return (
    <>
      <SubdomainIntroProse />
      <label>
        Subdomain
        <input
          type="text"
          name="subdomain"
          placeholder="my-business-name"
          autocomplete="off"
          pattern="[a-z0-9]([a-z0-9-]{'{'}0,61{'}'}[a-z0-9])?"
        />
        <span class="muted">{s.bunnyDnsSubdomainSuffix}</span>
      </label>
      <button type="submit">
        Check Availability &amp; Preview Complete Domain
      </button>
    </>
  );
};

export const HostSubdomainForm = (
  s: AdvancedSettingsPageState,
): JSX.Element | null =>
  s.bunnyDnsEnabled ? (
    <CsrfForm
      action="/admin/settings/host-subdomain"
      id="settings-host-subdomain"
    >
      <h2>Host Subdomain</h2>
      {SubdomainFormContent(s)}
    </CsrfForm>
  ) : null;
