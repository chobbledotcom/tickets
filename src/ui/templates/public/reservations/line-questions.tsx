/** The booking form fields for a question that asks for each booking line, or
 * for each ticket of a line. The question has one field group, with a field
 * for each line and ticket that the page can book. */

import type { TicketListing } from "#booking/model.ts";
import type { PackageBundleLimit } from "#booking/package-cap.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import {
  type BookingNode,
  type BookingTree,
  isMemberNodeOf,
} from "#booking/tree.ts";
import type { LineSlot, QuestionWithAnswers } from "#db/question-types.ts";
import {
  inHiddenPackage,
  lineKey,
  lineLabel,
  pageLineNames,
  ticketFieldName,
  unitsAsked,
} from "#db/questions/line-answers.ts";
import { requiredMapValue, sum } from "#fp";
import { t } from "#i18n";
import { savedFormValue } from "#shared/forms/saved-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { questionTextContent } from "#templates/components/question-text.tsx";

/** The page control that a line's quantity comes from, for the visibility
 * script:
 * - `q:<listing>`: a listing's own quantity
 * - `p:<package>:<fixed>`: a package count times the member's fixed quantity
 * - `c:<parent>:<child>`: a child's quantity under one parent */
type LineSource = string;

/** A booking line before its words: its slot, the most tickets it can take on
 * this page, and the control its quantity comes from. Each line comes from one
 * page path: a package member that is a child of a page parent is not offered
 * in the package. */
type LineShape = LineSlot & { cap: number; source: LineSource };

/** A booking line that the page can make, with its words. */
export type PageLine = LineShape & { label: string };

/** What the page knows about its listings, packages and children. */
export type LinePageInput = {
  childrenByParentId: ReadonlyMap<number, TicketListing[]>;
  listings: readonly TicketListing[];
  packageLimits: readonly PackageBundleLimit<PagePackage>[];
  tree: BookingTree;
};

/** The package a top-level node books through, or 0 for its own row. */
const packageOf = (
  node: BookingNode,
  packageLimits: LinePageInput["packageLimits"],
): PackageBundleLimit<PagePackage> | undefined =>
  packageLimits.find(({ pkg }) => isMemberNodeOf(pkg.groupId)(node));

/** The slot and cap of one shown top-level node. */
const topLevelLine = (
  node: BookingNode,
  { listings, packageLimits }: LinePageInput,
): LineShape => {
  const bundle = packageOf(node, packageLimits);
  const info = requiredMapValue(
    new Map(listings.map((listing) => [listing.listing.id, listing])),
    node.listingId,
  );
  const fixed =
    bundle === undefined || node.quantityRule.kind !== "FIXED"
      ? null
      : {
          groupId: bundle.pkg.groupId,
          limit: bundle.limit,
          qty: node.quantityRule.qty,
        };
  return {
    cap: fixed === null ? info.maxPurchasable : fixed.qty * fixed.limit,
    listingId: node.listingId,
    packageGroupId: bundle === undefined ? 0 : bundle.pkg.groupId,
    parentListingId: 0,
    source:
      fixed === null
        ? `q:${node.listingId}`
        : `p:${fixed.groupId}:${fixed.qty}`,
  };
};

/** The booking lines a buyer can make on the page, in page order. First come
 * the shown paths, then each child under each parent that can carry it. A child line
 * takes as many tickets as its parent's lines can. Each parent ticket carries
 * one child. A line of a hidden package is never named. */
export const pageAnswerLines = (input: LinePageInput): PageLine[] => {
  const { childrenByParentId, packageLimits, tree } = input;
  const packages = packageLimits.map(({ pkg }) => pkg);
  const topLevel = tree.nodes
    .filter((node) => node.visibility === "SHOWN")
    .map((node) => topLevelLine(node, input))
    .filter((line) => !inHiddenPackage(line, packages));
  const parentCaps = Map.groupBy(topLevel, ({ listingId }) => listingId);
  const children = [...parentCaps].flatMap(([parentId, parentLines]) =>
    (childrenByParentId.get(parentId) ?? []).map(({ listing }) => ({
      cap: sum(parentLines.map(({ cap }) => cap)),
      listingId: listing.id,
      packageGroupId: 0,
      parentListingId: parentId,
      source: `c:${parentId}:${listing.id}`,
    })),
  );
  const names = pageLineNames({ ...input, packages });
  return [...topLevel, ...children].map((line) => ({
    ...line,
    label: lineLabel(line, names),
  }));
};

/** The text field for one ticket of one line. The line key and the ticket let
 * the visibility script show the field only while the line takes the ticket. */
const ticketField = (
  question: QuestionWithAnswers,
  line: PageLine,
  unit: number,
): JSX.Element => {
  const name = ticketFieldName(question.id, { ...line, unit });
  return (
    <label
      class="custom-question"
      data-line={lineKey(line)}
      data-source={line.source}
      data-unit={String(unit)}
    >
      {question.answerLevel === "quantity"
        ? t("questions.line_answer.ticket", {
            line: line.label,
            number: unit + 1,
          })
        : line.label}
      <input
        maxlength={MAX_TEXTAREA_LENGTH}
        name={name}
        type="text"
        value={savedFormValue(name)}
      />
    </label>
  );
};

/** One question's fields: one for each line it asks, or one for each ticket a
 * line can take. The listing ids let the visibility script show the question
 * only while one of its listings is in the order. The script adds `required`,
 * and the server holds the rule. */
export const renderLineQuestion = (
  question: QuestionWithAnswers,
  lines: readonly PageLine[],
): JSX.Element => (
  <fieldset
    class="custom-question"
    data-listing-ids={[...new Set(lines.map((line) => line.listingId))].join(
      " ",
    )}
  >
    <legend>{questionTextContent(question)}</legend>
    {lines.flatMap((line) =>
      unitsAsked(question.answerLevel, line.cap).map((unit) =>
        ticketField(question, line, unit),
      ),
    )}
  </fieldset>
);
