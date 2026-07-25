/**
 * The Logistics tab panel: the address form with postcode search, the
 * latitude/longitude pin inputs with the map underneath, the shared
 * start/end selectors, and the "Other Attendees" list of bookings on the
 * same dates (hidden when there are none).
 *
 * The map and the "chosen address differs from what's typed" notice are
 * progressive enhancements (client/logistics-map.ts and
 * client/admin/address-lookup.ts); without JavaScript the form still edits
 * and saves everything.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  ATTENDEE_LOGISTICS_FORM_ID,
  type AttendeeLogisticsTabData,
  LAT_FIELD,
  LNG_FIELD,
  type OtherAttendeeLine,
} from "#routes/admin/attendee-logistics.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { defineTable } from "#shared/tables/definition.ts";
import { LogisticsSection } from "#templates/admin/attendee-form.tsx";
import { TitledSection } from "#templates/admin/entity-pages.tsx";
import { SaveActions } from "#templates/components/actions.tsx";
import { AddressFieldWithLookup } from "#templates/components/address-field.tsx";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import { ErrorAlert } from "#templates/components/error.tsx";
import { renderTable } from "#templates/components/table.tsx";

/* jscpd:ignore-end */

/** Props for the parts of the tab that render from the whole tab payload. */
type LogisticsTabProps = { data: AttendeeLogisticsTabData };

/** One latitude/longitude input. The map script re-pins as these change. */
const CoordinateInput = ({
  labelKey,
  name,
  value,
}: {
  labelKey: string;
  name: string;
  value: string;
}): JSX.Element => (
  <label for={name}>
    {t(labelKey)}
    <input
      autocomplete="off"
      data-coordinate
      id={name}
      inputmode="decimal"
      name={name}
      type="text"
      value={value}
    />
  </label>
);

/** The pinned-location block: the pair of inputs and the map container. The
 * map stays hidden until there is a pin to show (the script reveals it as
 * soon as coordinates appear). */
const PinnedLocation = ({ data }: LogisticsTabProps): JSX.Element => {
  const pinned = data.values.lat !== "" && data.values.lng !== "";
  return (
    <SectionFieldset
      className="listing-section"
      legend={t("attendee_logistics.location_heading")}
    >
      <p class="small">{t("attendee_logistics.location_hint")}</p>
      {data.locationError && <ErrorAlert>{data.locationError}</ErrorAlert>}
      <div class="location-inputs">
        <CoordinateInput
          labelKey="attendee_logistics.latitude"
          name={LAT_FIELD}
          value={data.values.lat}
        />
        <CoordinateInput
          labelKey="attendee_logistics.longitude"
          name={LNG_FIELD}
          value={data.values.lng}
        />
      </div>
      <div
        aria-label={t("attendee_logistics.map_label")}
        class="logistics-map"
        data-logistics-map
        hidden={!pinned}
        role="img"
      ></div>
    </SectionFieldset>
  );
};

/** A leg's time and (drop-off or collection) label in the others table. */
const legLabel = (time: string): string => time || "—";

const otherAttendeesTable = defineTable<OtherAttendeeLine>([
  {
    cell: (line) => (
      <a href={`/admin/attendees/${line.attendeeId}/logistics`}>{line.name}</a>
    ),
    header: () => t("attendee_logistics.col_attendee"),
    key: "attendee",
  },
  {
    cell: (line) => (
      <>
        {line.listingName}
        {line.quantity > 1 ? (
          <span class="muted small"> ×{line.quantity}</span>
        ) : null}
      </>
    ),
    header: () => t("terms.listing"),
    key: "listing",
  },
  {
    cell: (line) => formatDateRangeLabel(line.startAt, line.endAt),
    header: () => t("attendee_logistics.col_dates"),
    key: "dates",
  },
  {
    cell: (line) => legLabel(line.startTime),
    header: () => t("attendee_logistics.col_start"),
    key: "start",
  },
  {
    cell: (line) => legLabel(line.endTime),
    header: () => t("attendee_logistics.col_end"),
    key: "end",
  },
]);

/** The "Other Attendees" list: everyone else booked on overlapping dates,
 * each linking to their own Logistics tab. Renders nothing when empty. */
const OtherAttendees = ({
  others,
}: {
  others: OtherAttendeeLine[];
}): JSX.Element | null => {
  if (others.length === 0) return null;
  return (
    <TitledSection titleKey="attendee_logistics.others_heading">
      <p class="small">{t("attendee_logistics.others_hint")}</p>
      {renderTable(otherAttendeesTable, others)}
    </TitledSection>
  );
};

/** The whole Logistics tab: the save form, then the other attendees. */
export const AttendeeLogisticsPanel = ({
  data,
}: LogisticsTabProps): JSX.Element => (
  <>
    <CsrfForm
      action={`/admin/attendees/${data.attendee.id}/logistics`}
      id={ATTENDEE_LOGISTICS_FORM_ID}
    >
      <SectionFieldset
        className="listing-section"
        legend={t("attendee_logistics.address_heading")}
      >
        {data.addressError && <ErrorAlert>{data.addressError}</ErrorAlert>}
        <AddressFieldWithLookup address={data.values.address} />
        <output
          class="warning"
          data-address-diff
          data-diff-heading={t("attendee_logistics.diff_heading")}
          hidden
        ></output>
      </SectionFieldset>

      <PinnedLocation data={data} />

      <LogisticsSection logistics={data.logistics} />

      <SaveActions>{t("attendee_logistics.save")}</SaveActions>
    </CsrfForm>
    <OtherAttendees others={data.others} />
  </>
);
