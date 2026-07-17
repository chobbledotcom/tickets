import { t } from "#i18n";
import { toMajorUnits } from "#shared/currency.ts";
import {
  booleanToCheckbox,
  entityToFieldValues,
} from "#shared/forms/values.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type Group,
  type ListingWithCount,
} from "#shared/types.ts";
import { flashFormPage } from "#templates/admin/admin-page.tsx";
import { DataTable, namedColumns } from "#templates/components/data-table.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { getGroupCreateForm, getGroupForm } from "#templates/fields/group.ts";

const groupToFieldValues = (
  group?: Group,
): Record<string, string | number | null> =>
  entityToFieldValues(group, getGroupForm().fields, {
    hidden: (value) => booleanToCheckbox(value.hidden),
    hide_package_listings: (value) =>
      booleanToCheckbox(value.hide_package_listings),
    is_package: (value) => booleanToCheckbox(value.is_package),
    max_attendees: (value) => value.max_attendees || null,
  });

/** Admin group create page. */
export const adminGroupNewPage = flashFormPage(
  "groups.add.heading",
  "/admin/groups/new",
  () => (
    <NewResourceForm
      action="/admin/groups"
      fieldsHtml={getGroupCreateForm().render(groupToFieldValues())}
      submitLabel={t("groups.add.submit")}
      title={t("groups.add.heading")}
    />
  ),
);

/** A package member's saved price and quantity values, keyed by listing id. */
export type PackageMemberValues = ReadonlyMap<
  number,
  {
    price: number | null;
    quantity: number;
    dayPrices?: ReadonlyMap<number, number>;
  }
>;

const MemberDayPriceInputs = ({
  listing,
  dayPrices,
}: {
  listing: ListingWithCount;
  dayPrices: ReadonlyMap<number, number> | undefined;
}): JSX.Element => (
  <div class="package-day-prices">
    {availableDayCounts(listing).map((days) => {
      const override = dayPrices?.get(days);
      return (
        <label>
          {t("fields.group.package_day_price", { count: days })}
          <input
            inputmode="decimal"
            name={`package_day_price_${listing.id}_${days}`}
            // Every count from availableDayCounts has a configured day price.
            placeholder={toMajorUnits(dayPriceFor(listing, days)!)}
            type="text"
            value={override === undefined ? "" : toMajorUnits(override)}
          />
        </label>
      );
    })}
  </div>
);

/** A package group's member listings plus their saved price/quantity values —
 *  the pair the members table and the edit panel both work from. */
type PackageMembersProps = {
  listings: ListingWithCount[];
  members: PackageMemberValues;
};

const PackageMembersTable = ({
  listings,
  members,
}: PackageMembersProps): JSX.Element => (
  <div class="package-prices">
    <h2>{t("groups.package_prices.heading")}</h2>
    <p>{t("groups.package_prices.hint")}</p>
    {listings.length === 0 ? (
      <p>{t("groups.package_prices.no_listings")}</p>
    ) : (
      <DataTable
        columns={namedColumns(
          "fields.group.package_price",
          "fields.group.package_quantity",
        )}
        rows={listings.map((listing) => {
          const member = members.get(listing.id);
          // null/absent means no override; 0 means free.
          const override = member?.price ?? null;
          return [
            listing.name,
            <>
              <input
                inputmode="decimal"
                name={`package_price_${listing.id}`}
                placeholder={toMajorUnits(listing.unit_price)}
                type="text"
                value={override === null ? "" : toMajorUnits(override)}
              />
              {listing.customisable_days && (
                <MemberDayPriceInputs
                  dayPrices={member?.dayPrices}
                  listing={listing}
                />
              )}
            </>,
            <input
              inputmode="numeric"
              min="1"
              name={`package_qty_${listing.id}`}
              type="number"
              value={String(member?.quantity ?? 1)}
            />,
          ];
        })}
      />
    )}
  </div>
);

/** The Edit tab's group fields and per-listing package values. */
export const GroupEditPanel = ({
  group,
  listings,
  members,
}: PackageMembersProps & { group: Group }): JSX.Element => (
  <SaveForm
    action={`/admin/groups/${group.id}/edit`}
    submitLabel={t("common.save_changes")}
  >
    <Raw html={getGroupForm().render(groupToFieldValues(group))} />
    <PackageMembersTable listings={listings} members={members} />
  </SaveForm>
);
