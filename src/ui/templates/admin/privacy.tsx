/**
 * Privacy page (owner-only).
 *
 * A short intro states the essentials: this is a ticketing system, not a CRM;
 * connect a CRM with a listing webhook; and returning customers are recognised
 * by a one-way code, not by storing their email or phone. Below it sit the two
 * tools: tidying up orphaned attendee records, and a GDPR erasure of a single
 * contact's record by email or phone.
 *
 * All copy lives in the privacy.* locale keys; the prose blocks are authored as
 * HTML there and rendered via <Raw>, matching the admin guide.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { OrphanPaymentWorkPage } from "#shared/db/orphan-attendees.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { ORPHAN_RETENTION_OPTIONS } from "#shared/orphan-retention.ts";
import type { ProviderRefundCasePage } from "#shared/db/provider-refund-cases.ts";
import type { AdminSession } from "#shared/types.ts";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import { ProviderRefundCaseQueue } from "#templates/admin/provider-refund-cases.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import {
  choiceOptions,
  SelectField,
} from "#templates/components/select-field.tsx";
/* jscpd:ignore-end */

export type PrivacyPageData = {
  /** Bounded, PII-free cases whose provider outcome still needs attention. */
  providerRefundCases: ProviderRefundCasePage;
  /** Orphans available to ordinary cleanup, excluding protected payment work. */
  purgeableOrphanCount: number;
  /** Orphans retained because a payment still needs owner attention. */
  paymentWorkPage: OrphanPaymentWorkPage;
  /** Currently saved retention age (whole days, as a string). */
  orphanRetention: string;
  /** Whether automatic orphan purging is enabled. */
  autoPurgeOrphans: boolean;
} & FlashFields;

/** The "older than" age dropdown, current age pre-selected. */
const RetentionSelect = ({ selected }: { selected: string }): JSX.Element => (
  <label>
    {t("privacy.orphans.retention_label")}
    <SelectField
      name="retention"
      options={choiceOptions(ORPHAN_RETENTION_OPTIONS)}
      value={selected}
    />
  </label>
);

/** Tidy-up-orphans form: age + auto-purge toggle, with Save / Delete-now. */
const OrphansForm = ({
  orphanRetention,
  autoPurgeOrphans,
  paymentWorkPage,
  purgeableOrphanCount,
}: Pick<
  PrivacyPageData,
  | "orphanRetention"
  | "autoPurgeOrphans"
  | "paymentWorkPage"
  | "purgeableOrphanCount"
>): JSX.Element => (
  <CsrfForm action="/admin/privacy/orphans" id="privacy-orphans">
    <div class="prose">
      <h2>{t("privacy.orphans.heading")}</h2>
      <Raw html={t("privacy.orphans.intro_html")} />
      <p>
        {t("privacy.orphans.purgeable_count", {
          count: purgeableOrphanCount,
        })}
      </p>
      {(paymentWorkPage.attendeeIds.length > 0 ||
        paymentWorkPage.previousCursor !== null ||
        paymentWorkPage.nextCursor !== null) && (
        <section>
          <h3>{t("privacy.orphans.payment_work_heading")}</h3>
          <p>{t("privacy.orphans.payment_work_intro")}</p>
          {paymentWorkPage.attendeeIds.length > 0
            ? (
              <ul>
                {paymentWorkPage.attendeeIds.map((attendeeId) => (
                  <li>
                    <a href={`/admin/attendees/${attendeeId}`}>
                      {t("privacy.orphans.payment_work_link", {
                        id: attendeeId,
                      })}
                    </a>
                  </li>
                ))}
              </ul>
            )
            : <p>{t("privacy.orphans.payment_work_empty_page")}</p>}
          <nav class="pagination">
            {paymentWorkPage.previousCursor !== null
              ? (
                <a
                  href={`/admin/privacy?work_before=${paymentWorkPage.previousCursor}`}
                  rel="prev"
                >
                  {t("privacy.orphans.payment_work_previous")}
                </a>
              )
              : <span />}
            {paymentWorkPage.nextCursor !== null
              ? (
                <a
                  href={`/admin/privacy?work_after=${paymentWorkPage.nextCursor}`}
                  rel="next"
                >
                  {t("privacy.orphans.payment_work_next")}
                </a>
              )
              : <span />}
          </nav>
        </section>
      )}
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
      <SelectField
        name="contact_type"
        options={[
          { label: t("privacy.erase.type_email"), value: "email" },
          { label: t("privacy.erase.type_phone"), value: "sms" },
        ]}
        value=""
      />
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
  renderAdminPage(
    "/admin/privacy",
    session,
    t("privacy.title"),
    <>
      <div class="prose">
        <Raw html={t("privacy.intro_html")} />
      </div>

      <Flash error={data.error} info={data.info} success={data.success} />

      <ProviderRefundCaseQueue page={data.providerRefundCases} />

      <OrphansForm
        autoPurgeOrphans={data.autoPurgeOrphans}
        orphanRetention={data.orphanRetention}
        paymentWorkPage={data.paymentWorkPage}
        purgeableOrphanCount={data.purgeableOrphanCount}
      />

      <EraseForm />

      <GuideFooter href="/admin/guide#data-privacy">
        {t("privacy.guide_link")}
      </GuideFooter>
    </>,
  );
