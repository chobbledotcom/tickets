/**
 * The scope and answer link editors on the modifier edit page — "tick the
 * listings / groups / answers this modifier applies to". Both are backed by the
 * shared LinkedItemsCheckboxes component.
 */

import { t } from "#i18n";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import type { Modifier } from "#types";

/** Each linkable scope kind → the form field its checkboxes post under and the
 * term key for its plural type name. Adding a scope kind is one self-contained
 * entry here; the ScopeLinkKind union and both the field name and heading follow
 * from this table, so there are no per-kind ternaries to keep in sync. */
export const SCOPE_LINK_KINDS = {
  groups: { field: "group_ids", term: "terms.groups" },
  listings: { field: "listing_ids", term: "terms.listings" },
} as const satisfies Record<string, { field: string; term: string }>;

export type ScopeLinkKind = keyof typeof SCOPE_LINK_KINDS;

/** Candidate listings/groups and current links for the scope editor.
 * Listings carry their active flag (a deactivated one renders muted); groups
 * have no deactivated state, so they arrive already active. */
export type ScopeLinks = {
  kind: ScopeLinkKind;
  options: { id: number; name: string; active: boolean }[];
  selected: number[];
};

/** Candidate answers and current links for an "answer"-triggered modifier.
 * Options are flattened across questions; each name reads "Question — Answer". */
export type AnswerLinks = {
  options: { id: number; name: string }[];
  selected: number[];
};

/** One heading with its tickable items — the single group both link editors
 *  show. Each item is named and either active (normal) or deactivated (muted). */
const OneGroupCheckboxes = ({
  label,
  options,
  selected,
  name,
}: Pick<ScopeLinks, "options" | "selected"> & {
  label: string;
  name: string;
}): JSX.Element => (
  <LinkedItemsCheckboxes
    groups={[{ label, options: toLinkedItemOptions(options, selected) }]}
    name={name}
  />
);

/** The listing/group link editor shown on the edit page for a scoped modifier. */
export const ScopeLinksForm = ({
  modifier,
  links,
}: {
  modifier: Modifier;
  links: ScopeLinks;
}): JSX.Element => {
  const { field, term } = SCOPE_LINK_KINDS[links.kind];
  return (
    <SaveForm
      action={`/admin/modifiers/${modifier.id}/links`}
      submitLabel={t("modifiers.scope.save")}
    >
      {links.options.length === 0 ? (
        <p>{t("modifiers.scope.none")}</p>
      ) : (
        <OneGroupCheckboxes
          label={t(term)}
          name={field}
          options={links.options}
          selected={links.selected}
        />
      )}
    </SaveForm>
  );
};

/** The answer link editor shown on the edit page for an "answer"-triggered
 *  modifier: tick the question answers that apply this modifier. Answers have
 *  no deactivated state, so every option arrives active. */
export const AnswerLinksForm = ({
  modifier,
  answerLinks,
}: {
  modifier: Modifier;
  answerLinks: AnswerLinks;
}): JSX.Element => (
  <SaveForm
    action={`/admin/modifiers/${modifier.id}/answers`}
    submitLabel={t("modifiers.answers.save")}
  >
    <p>
      <small>{t("modifiers.answers.hint")}</small>
    </p>
    {answerLinks.options.length === 0 ? (
      <p>{t("modifiers.answers.none")}</p>
    ) : (
      <OneGroupCheckboxes
        label={t("terms.answers")}
        name="answer_ids"
        options={answerLinks.options.map((option) => ({
          ...option,
          active: true,
        }))}
        selected={answerLinks.selected}
      />
    )}
  </SaveForm>
);
