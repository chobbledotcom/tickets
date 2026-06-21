import { t } from "#i18n";
import { getRenewalUrl } from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
/**
 * Not found page
 */
export const notFoundPage = (): string =>
  String(
    <Layout title={t("public.not_found.title")}>
      <h1>{t("public.not_found.heading")}</h1>
    </Layout>,
  );

/**
 * QR booking link error page shown when a signed link is invalid or expired.
 * Always includes a fallback link to the normal listing booking page.
 */
export const qrBookErrorPage = (slug: string): string =>
  String(
    <Layout title={t("public.qr_book_error.title")}>
      <div class="prose">
        <h1>{t("public.qr_book_error.heading")}</h1>
        <p>{t("public.qr_book_error.message")}</p>
        <p>
          <a href={`/ticket/${escapeHtml(slug)}`}>
            {t("public.qr_book_error.booking_link")}
          </a>
        </p>
      </div>
    </Layout>,
  );

/**
 * Rate limit page shown on 429 responses for token URLs
 */
export const rateLimitedPage = (): string =>
  String(
    <Layout title={t("public.rate_limited.title")}>
      <div class="prose">
        <h1>{t("public.rate_limited.heading")}</h1>
        <p>{t("public.rate_limited.message")}</p>
      </div>
    </Layout>,
  );

/**
 * Inline styles for error dialog pages — self-contained so the page renders
 * correctly even when the database or CDN assets are unavailable
 */
const ERROR_DIALOG_STYLE = `<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f8fafc;color:#0f172a}
main{max-width:36rem;margin:18vh auto 0;padding:0 1.5rem}
h1{font-size:1.875rem;line-height:1.2;margin:0 0 .75rem}
p{line-height:1.5;margin:.75rem 0}
a{color:#0369a1}
</style>`;

/**
 * Temporary error page with auto-refresh
 * Used when a transient CDN or network error occurs
 */
const TEMPORARY_ERROR_HEAD = `<meta http-equiv="refresh" content="2" />
${ERROR_DIALOG_STYLE}`;

export const temporaryErrorPage = (): string =>
  String(
    <Layout
      headExtra={TEMPORARY_ERROR_HEAD}
      title={t("public.temporary_error.title")}
    >
      <div class="prose">
        <h1>{t("public.temporary_error.heading")}</h1>
        <p>{t("public.temporary_error.message")}</p>
        <p>
          <small>
            Check{" "}
            <strong>
              <a href="https://status.bunny.net/">status.bunny.net</a>
            </strong>
          </small>
        </p>
      </div>
    </Layout>,
  );

/**
 * Shown when a write could not acquire a database lock after retrying — the
 * database is momentarily too busy.
 *
 * `autoRefresh` is only safe for idempotent requests (GET/HEAD): the meta
 * refresh reloads the URL as a GET, which for a POST would drop the submitted
 * form body without replaying the write. So for non-idempotent methods we skip
 * the refresh and ask the user to go back and resubmit instead.
 */
export const databaseBusyPage = (autoRefresh: boolean): string =>
  String(
    <Layout
      headExtra={autoRefresh ? TEMPORARY_ERROR_HEAD : ERROR_DIALOG_STYLE}
      title={t("public.database_busy.title")}
    >
      <div class="prose">
        <h1>{t("public.database_busy.heading")}</h1>
        <p>
          {autoRefresh
            ? t("public.database_busy.message")
            : t("public.database_busy.message_manual")}
        </p>
      </div>
    </Layout>,
  );

/**
 * Shown while another isolate is running a database migration (including its
 * pre-migration backup). Auto-refreshes like the temporary error page, but
 * with a reassuring message so the user knows work is happening rather than
 * seeing a generic error. The backup can take a few seconds on larger
 * databases, so refresh a little slower than the temporary error page.
 */
const MIGRATION_IN_PROGRESS_HEAD = `<meta http-equiv="refresh" content="5" />
${ERROR_DIALOG_STYLE}`;

export const migrationInProgressPage = (): string =>
  String(
    <Layout
      headExtra={MIGRATION_IN_PROGRESS_HEAD}
      title={t("public.migration_in_progress.title")}
    >
      <div class="prose">
        <h1>{t("public.migration_in_progress.heading")}</h1>
        <p>
          <Raw html={t("public.migration_in_progress.message")} />
        </p>
      </div>
    </Layout>,
  );

/**
 * Shown on non-setup routes when the site's database has not been set up
 * yet. No auto-refresh: retrying cannot succeed until someone completes
 * /setup, so an endlessly reloading error page would just be confusing.
 */
export const siteNotActivatedPage = (): string =>
  String(
    <Layout
      headExtra={ERROR_DIALOG_STYLE}
      title={t("public.not_activated.title")}
    >
      <div class="prose">
        <h1>{t("public.not_activated.heading")}</h1>
        <p>{t("public.not_activated.message")}</p>
      </div>
    </Layout>,
  );

/**
 * Read-only mode page
 */
export const readOnlyPage = (): string => {
  const renewalUrl = getRenewalUrl();
  return String(
    <Layout title={t("public.read_only.title")}>
      <p>
        {t("public.read_only.message")}
        {renewalUrl && (
          <Raw
            html={` <a href="${escapeHtml(renewalUrl)}">${t(
              "public.read_only.renew_now",
            )}</a>`}
          />
        )}
      </p>
    </Layout>,
  );
};
