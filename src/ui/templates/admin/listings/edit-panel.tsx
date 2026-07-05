import { map } from "#fp";
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import type { ListingAggregateRecalculation } from "#shared/db/listings.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { inferTemplate } from "#shared/listing-templates.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { MoneyAdjustSection } from "#templates/admin/money-adjust-section.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import {
  CheckboxForm,
  CheckboxLabel,
  type RunningTotalsConfig,
  RunningTotalsFieldset,
  StackDetails,
} from "#templates/components/aggregate-sections.tsx";
import { listingAggregateFields } from "#templates/fields.ts";
import {
  ListingAggregateMismatchNotice,
  listingAggregateToFieldValues,
} from "./aggregates.tsx";
import {
  advancedSectionHasValues,
  DurationWarning,
  listingFormPageState,
} from "./form-sections.tsx";
import { listingFormClassAttr, listingToFieldValues } from "./form-values.tsx";
import type { ChildCandidate, ListingEditPanelOptions } from "./types.ts";

const ListingIncomeAdjustSection = ({
  listing,
  show,
}: {
  listing: ListingWithCount;
  show: boolean;
}): JSX.Element | null =>
  show ? (
    <MoneyAdjustSection
      action={`/admin/listing/${listing.id}/income`}
      className="listing-section"
      currentLabel={t("listings_table.adjust_income_current")}
      currentValue={listing.income}
      inputId="income"
      inputLabel={t("listings_table.adjust_income_new_label")}
      inputMin="0"
      link={{
        href: `/admin/listing/${listing.id}#income-ledger`,
        label: t("listings_table.income_ledger_link"),
      }}
      submitLabel={t("listings_table.adjust_income_submit")}
      title={t("listings_table.adjust_income")}
      warning={t("listings_table.adjust_income_warning")}
    />
  ) : null;

const ListingRunningTotalsSection = ({
  aggregateRecalculation,
  listing,
  show,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  listing: ListingWithCount;
  show: boolean;
}): JSX.Element | null =>
  show ? (
    <RunningTotalsFieldset config={listingRunningTotalsConfig(listing)}>
      <ListingAggregateMismatchNotice
        actionHref={`/admin/listings/recalculate/${listing.id}`}
        aggregateRecalculation={aggregateRecalculation}
      />
    </RunningTotalsFieldset>
  ) : null;

const listingRunningTotalsConfig = (
  listing: ListingWithCount,
): RunningTotalsConfig => ({
  className: "listing-section",
  fields: listingAggregateFields,
  legend: t("listings_table.running_totals"),
  note: t("listings_table.running_totals_note"),
  recalculateHref: `/admin/listings/recalculate/${listing.id}`,
  recalculateLabel: t("listings_table.recalculate_totals"),
  values: listingAggregateToFieldValues(listing),
});

const ChildCandidateLabel = ({
  candidate,
  checked,
}: {
  candidate: ChildCandidate;
  checked: boolean;
}) => {
  const disabled = candidate.ineligibleReason !== null;
  return (
    <CheckboxLabel
      checked={checked || undefined}
      disabled={disabled}
      label={` ${candidate.listing.name}`}
      name="child_listing_ids"
      value={String(candidate.listing.id)}
    >
      {candidate.ineligibleReason !== null && (
        <span class="muted small">
          {"\u2014"} {candidate.ineligibleReason}
        </span>
      )}
    </CheckboxLabel>
  );
};

const ListingChildrenSection = ({
  listingId,
  candidates,
  childIds,
  offeredUnder,
}: {
  listingId: number;
  candidates: ChildCandidate[];
  childIds: ReadonlySet<number>;
  offeredUnder: ListingWithCount[];
}) => (
  <StackDetails
    className="listing-advanced listing-children"
    open
    summary={t("listings_table.advanced_settings")}
  >
    <h2>{t("listings_table.children_legend")}</h2>
    <p>{t("listings_table.children_help")}</p>
    {offeredUnder.length > 0 && (
      <p>
        {t("listings_table.children_offered_under", {
          names: offeredUnder.map((parent) => parent.name).join(", "),
        })}
      </p>
    )}
    {candidates.length === 0 ? (
      <p>
        <em>{t("listings_table.children_none")}</em>
      </p>
    ) : (
      <CheckboxForm
        action={`/admin/listing/${listingId}/children`}
        submitLabel={t("listings_table.children_save")}
      >
        {map((candidate: ChildCandidate) => (
          <ChildCandidateLabel
            candidate={candidate}
            checked={childIds.has(candidate.listing.id)}
          />
        ))(candidates)}
      </CheckboxForm>
    )}
  </StackDetails>
);

const ListingAssetDeleteForm = ({
  action,
  label,
}: {
  action: string;
  label: string;
}): JSX.Element => (
  <CsrfForm action={action}>
    <SubmitButton class="secondary" icon="trash-2">
      {label}
    </SubmitButton>
  </CsrfForm>
);

export const ListingEditPanel = ({
  listing,
  groups,
  session,
  error,
  aggregateRecalculation,
  parents,
  selectedGroupIds = [],
}: ListingEditPanelOptions): JSX.Element => {
  const offeredUnder = parents?.offeredUnder ?? [];
  const childOfNames =
    offeredUnder.length > 0
      ? offeredUnder.map((parent) => parent.name).join(", ")
      : null;
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  const durationWarning = String(<DurationWarning listing={listing} />);
  const template = inferTemplate(listing);
  const showFinancials = session.adminLevel !== "editor";
  const form = listingFormPageState(
    session,
    groups,
    selectedGroupIds,
    !!template,
    { includeSlug: true },
  );
  return (
    <>
      <Flash error={error} />
      {childOfNames !== null && (
        <p class="notice listing-child-banner">
          {t("listings_table.child_banner", { names: childOfNames })}
        </p>
      )}
      <CsrfForm
        action={`/admin/listing/${listing.id}/edit`}
        {...listingFormClassAttr(template, form.defaults)}
        enctype="multipart/form-data"
        id="listing-edit-form"
      >
        {form.formSections({
          advancedOpen:
            advancedSectionHasValues(listing, builderEnabled) || !!error,
          childOfNote:
            childOfNames !== null
              ? t("listings_table.child_field_inherited")
              : "",
          customiseOpen: !!error,
          dayPricesListing: listing,
          durationWarning,
          useDefaultsChecked: listing.use_defaults,
          values: listingToFieldValues(listing),
        })}
        <ListingRunningTotalsSection
          aggregateRecalculation={aggregateRecalculation}
          listing={listing}
          show={showFinancials}
        />
        <SubmitButton icon="save" id="listing-edit-submit">
          {t("common.save_changes")}
        </SubmitButton>
      </CsrfForm>
      <ListingIncomeAdjustSection listing={listing} show={showFinancials} />
      {storageEnabled && listing.attachment_name && (
        <div class="attachment-info">
          <p>
            {t("listings_table.current_attachment", {
              name: listing.attachment_name,
            })}
          </p>
          <ListingAssetDeleteForm
            action={`/admin/listing/${listing.id}/attachment/delete`}
            label={t("listings_table.remove_attachment")}
          />
        </div>
      )}
      {parents && (
        <ListingChildrenSection
          candidates={parents.candidates}
          childIds={parents.childIds}
          listingId={listing.id}
          offeredUnder={parents.offeredUnder}
        />
      )}
    </>
  );
};

export type { ListingEditPanelOptions } from "./types.ts";
