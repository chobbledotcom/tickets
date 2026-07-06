/**
 * "Linked items" checkbox lists: one checkbox per linkable item, grouped by
 * item type (Listings, Groups, …). With several types each type gets its own
 * labelled row in a list; with a single type the heading and checkboxes share
 * one wrapping line. The heading counts the items currently linked, and
 * deactivated items sort to the end of their row and render muted.
 */

import { t } from "#i18n";
import { CheckboxLabel } from "#templates/components/aggregate-sections.tsx";

export type LinkedItemOption = {
  /** Deactivated items render muted at the end of their row. */
  active: boolean;
  checked: boolean;
  label: string;
  value: string;
};

export type LinkedItemGroup = {
  /** Plural type name shown before the row, e.g. t("terms.listings"). */
  label: string;
  options: readonly LinkedItemOption[];
};

const activeFirst = (
  options: readonly LinkedItemOption[],
): LinkedItemOption[] => [
  ...options.filter((option) => option.active),
  ...options.filter((option) => !option.active),
];

const countLinked = (groups: readonly LinkedItemGroup[]): number =>
  groups.flatMap((group) => group.options).filter((option) => option.checked)
    .length;

const optionCheckboxes =
  (name: string) =>
  (options: readonly LinkedItemOption[]): JSX.Element[] =>
    activeFirst(options).map((option) => (
      <CheckboxLabel
        checked={option.checked || undefined}
        className={option.active ? undefined : "muted"}
        label={option.label}
        name={name}
        value={option.value}
      />
    ));

export const LinkedItemsCheckboxes = ({
  groups,
  name,
}: {
  groups: readonly LinkedItemGroup[];
  /** The checkbox input name shared by every option. */
  name: string;
}): JSX.Element => {
  const withOptions = groups.filter((group) => group.options.length > 0);
  const checkboxes = optionCheckboxes(name);
  const count = countLinked(withOptions);
  const only = withOptions.length === 1 ? withOptions[0] : undefined;
  if (only) {
    return (
      <fieldset class="checkboxes">
        <strong>
          {t("linked_items.heading_typed", {
            count,
            type: only.label.toLowerCase(),
          })}
        </strong>
        {checkboxes(only.options)}
      </fieldset>
    );
  }
  return (
    <>
      <p>
        <strong>{t("linked_items.heading", { count })}</strong>
      </p>
      <ul class="linked-items">
        {withOptions.map((group) => (
          <li class="checkboxes">
            <strong>{group.label}:</strong>
            {checkboxes(group.options)}
          </li>
        ))}
      </ul>
    </>
  );
};
