/**
 * Privacy page (owner-only).
 *
 * Explains, in plain language, that this is a ticketing system rather than a
 * CRM, what limited data it keeps, and how the privacy-protecting "last seen"
 * note works. Below the explainer sit two tools: tidying up orphaned attendee
 * records, and a GDPR erasure of a single contact's record by email or phone.
 *
 * All copy lives in the privacy.* locale keys; the prose blocks are authored as
 * HTML there and rendered via <Raw>, matching the admin guide.
 */

import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { ORPHAN_RETENTION_OPTIONS } from "#shared/orphan-retention.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type PrivacyPageData = {
  /** Total orphaned attendee records currently in the database. */
  orphanCount: number;
  /** Currently saved retention age (whole days, as a string). */
  orphanRetention: string;
  /** Whether automatic orphan purging is enabled. */
  autoPurgeOrphans: boolean;
  error?: string;
  success?: string;
  info?: string;
};

/** The "older than" age dropdown, current age pre-selected. */
const RetentionSelect = ({ selected }: { selected: string }): JSX.Element => (
  <label>
    {t("privacy.orphans.retention_label")}
    <select name="retention">
      {ORPHAN_RETENTION_OPTIONS.map((option) => (
        <option selected={option.value === selected} value={option.value}>
          {t(option.labelKey)}
        </option>
      ))}
    </select>
  </label>
);

/** Tidy-up-orphans form: age + auto-purge toggle, with Save / Delete-now. */
const OrphansForm = ({
  orphanCount,
  orphanRetention,
  autoPurgeOrphans,
}: Pick<
  PrivacyPageData,
  "orphanCount" | "orphanRetention" | "autoPurgeOrphans"
>): JSX.Element => (
  <CsrfForm action="/admin/privacy/orphans" id="privacy-orphans">
    <div class="prose">
      <h2>{t("privacy.orphans.heading")}</h2>
      <Raw html={t("privacy.orphans.intro_html")} />
      <p>{t("privacy.orphans.count", { count: orphanCount })}</p>
    </div>
    <RetentionSelect selected={orphanRetention} />
    <label class="checkbox">
      <input
        checked={autoPurgeOrphans}
        name="auto_purge"
        type="checkbox"
        value="1"
      />{" "}
      {t("privacy.orphans.auto_label")}
    </label>
    <small>{t("privacy.orphans.auto_hint")}</small>
    <p class="actions">
      <button name="action" type="submit" value="save">
        {t("privacy.orphans.save_button")}
      </button>{" "}
      <button class="danger" name="action" type="submit" value="purge">
        {t("privacy.orphans.purge_button")}
      </button>
    </p>
  </CsrfForm>
);

/** GDPR erasure form: pick email/phone, enter the value, delete the record. */
const EraseForm = (): JSX.Element => (
  <CsrfForm action="/admin/privacy/erase" id="privacy-erase">
    <div class="prose">
      <h2>{t("privacy.erase.heading")}</h2>
      <Raw html={t("privacy.erase.intro_html")} />
    </div>
    <label>
      {t("privacy.erase.type_label")}
      <select name="contact_type">
        <option value="email">{t("privacy.erase.type_email")}</option>
        <option value="sms">{t("privacy.erase.type_phone")}</option>
      </select>
    </label>
    <label>
      {t("privacy.erase.identifier_label")}
      <input name="identifier" type="text" />
      <small>{t("privacy.erase.identifier_hint")}</small>
    </label>
    <button class="danger" type="submit">
      {t("privacy.erase.button")}
    </button>
  </CsrfForm>
);

export const adminPrivacyPage = (
  session: AdminSession,
  data: PrivacyPageData,
): string =>
  String(
    <Layout title={t("privacy.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <div class="prose">
        <h1>{t("privacy.title")}</h1>
        <h2>{t("privacy.not_a_crm_heading")}</h2>
        <Raw html={t("privacy.not_a_crm_html")} />
        <h2>{t("privacy.aggregate_heading")}</h2>
        <Raw html={t("privacy.aggregate_html")} />
        <h2>{t("privacy.hashing_heading")}</h2>
        <Raw html={t("privacy.hashing_html")} />
      </div>

      <Flash error={data.error} info={data.info} success={data.success} />

      <OrphansForm
        autoPurgeOrphans={data.autoPurgeOrphans}
        orphanCount={data.orphanCount}
        orphanRetention={data.orphanRetention}
      />

      <EraseForm />
    </Layout>,
  );
