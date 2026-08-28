/**
 * "Linked items" checkbox lists: one checkbox per linkable item, grouped by
 * item type.
 *
 * Checked items sort to the front, so the current selection is visible at a
 * glance. Deactivated items sort to the end, but a checked deactivated item
 * still leads, as any linked item does.
 */

import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
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

/** Builds the heading from the linked count and the lowercased type name
 * (`type` is null for a multi-type list). Pass a custom one to change the
 * wording — e.g. an "Add {type}:" picker heading with no count. */
export type LinkedItemsHeading = (args: {
  count: number;
  type: string | null;
}) => Child;

/** Map plain `{id, name, active}` rows plus the set of linked ids into checkbox
 * options — the shared shape every simple (id-valued) caller feeds the list. */
export const toLinkedItemOptions = (
  options: readonly { active: boolean; id: number; name: string }[],
  selectedIds: Iterable<number>,
): LinkedItemOption[] => {
  const selected = new Set(selectedIds);
  return options.map((option) => ({
    active: option.active,
    checked: selected.has(option.id),
    label: option.name,
    value: String(option.id),
  }));
};

const defaultHeading: LinkedItemsHeading = ({ count, type }) =>
  type === null
    ? t("linked_items.heading", { count })
    : t("linked_items.heading_typed", { count, type });

/** Stable partition: options matching `keep` first, the rest after, each half
 * in its original order. The one ordering primitive both sorts below share. */
const matchingFirst =
  (keep: (option: LinkedItemOption) => boolean) =>
  (options: readonly LinkedItemOption[]): LinkedItemOption[] => [
    ...options.filter(keep),
    ...options.filter((option) => !keep(option)),
  ];

/** Deactivated options sort to the end of their row (rendered muted). */
const activeFirst = matchingFirst((option) => option.active);

/** The already-linked (checked) options lead, keeping every option's relative
 * order otherwise. Applied over {@link activeFirst}, so the displayed order is:
 * linked first, then within each half active-before-muted. */
const selectedFirst = matchingFirst((option) => option.checked);

const countLinked = (groups: readonly LinkedItemGroup[]): number =>
  groups.flatMap((group) => group.options).filter((option) => option.checked)
    .length;

const optionCheckboxes =
  (name: string) =>
  (options: readonly LinkedItemOption[]): JSX.Element[] =>
    selectedFirst(activeFirst(options)).map((option) => (
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
  heading = defaultHeading,
  leading,
}: {
  groups: readonly LinkedItemGroup[];
  /** The checkbox input name shared by every option. */
  name: string;
  /** Override the default "Linked …" heading wording. */
  heading?: LinkedItemsHeading | undefined;
  /** Rendered inside a single-type list, before its checkboxes (e.g. a
   * "select all" toggle). */
  leading?: Child | undefined;
}): JSX.Element => {
  const withOptions = groups.filter((group) => group.options.length > 0);
  const checkboxes = optionCheckboxes(name);
  const count = countLinked(withOptions);
  const only = withOptions.length === 1 ? withOptions[0] : undefined;
  if (only) {
    return (
      <fieldset class="checkboxes">
        <strong>{heading({ count, type: only.label.toLowerCase() })}</strong>
        {leading}
        {checkboxes(only.options)}
      </fieldset>
    );
  }
  return (
    <>
      <p>
        <strong>{heading({ count, type: null })}</strong>
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
