import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { t } from "#i18n";
import { Flash } from "#shared/forms/flash.tsx";
import type { AttendeeMergeDiff } from "#shared/merge/attendee-merge-types.ts";
import { MergeDecisionTables } from "#templates/admin/attendees/merge-tables.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import type { Attendee } from "#types";

type MergeSourceInfo = {
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  ticket_token: string;
  bookings: ListingAttendeeRow[];
};

/** Search for and merge a source attendee into the current attendee. */
export const AttendeeMergePanel = (
  target: Attendee,
  source: MergeSourceInfo | null,
  searchToken: string | null,
  error?: string,
  mergeDiff?: AttendeeMergeDiff,
): JSX.Element => (
  <article>
    <Flash error={error} />

    <h3>{t("admin.attendees.merge_attendee")}</h3>
    <h4>{t("admin.attendees.search_by_token")}</h4>
    <form
      action={`/admin/attendees/${target.id}/actions`}
      class="inline-row"
      method="get"
    >
      <label for="token">
        {t("admin.attendees.merge_token_label")}
        <input
          autofocus={!source}
          id="token"
          name="token"
          placeholder={t("attendee_form.enter_ticket_token_placeholder")}
          required
          type="text"
          value={searchToken || ""}
        />
      </label>
      <SubmitButton icon="search">
        {t("attendee_form.search_button")}
      </SubmitButton>
    </form>

    {source && mergeDiff && (
      <div>
        <div class="prose">
          <h3>{t("admin.attendees.merge_preview")}</h3>
          <p>{t("admin.attendees.merge_intro")}</p>
        </div>

        <SaveForm
          action={`/admin/attendees/${target.id}/merge`}
          submitClass="danger"
          submitIcon="trash-2"
          submitLabel={t("admin.attendees.merge_submit")}
        >
          <input
            name="source_token"
            type="hidden"
            value={source.ticket_token}
          />
          <input name="merge_version" type="hidden" value={mergeDiff.version} />

          <MergeDecisionTables
            diff={mergeDiff}
            sourceName={source.name}
            targetName={target.name}
          />

          <p>
            <strong>{t("admin.attendees.merge_warning_label")}:</strong>{" "}
            {t("admin.attendees.merge_warning_text")}
          </p>
        </SaveForm>
      </div>
    )}
  </article>
);
