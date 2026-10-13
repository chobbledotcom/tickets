/**
 * The judge applied to the submitted cart. Every in-cart option's question
 * goes to the one option-demand judge with the buyer's own child choices.
 * A refusal the fold's walk does not name refuses the submission with the
 * walk's own message. Capacity is not refused here. The fold's walk refuses
 * the structural capacity cases with their precise messages. The checkout's
 * batched SQL stays the atomic per-date enforcement.
 */

/* jscpd:ignore-start -- imports */
import type { FoldBase } from "#booking/fold-tree.ts";
import type { TicketListing } from "#booking/model.ts";
import {
  judgeOptionDemand,
  type OptionDemandQuestion,
} from "#booking/option-demand.ts";
import { packageMemberIds } from "#booking/page-packages.ts";
import type { Holiday } from "#db/holidays.ts";
import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { requireValue } from "#shared/required-value.ts";
/* jscpd:ignore-end */
import type { TicketCtx } from "./types.ts";

/** The gate's verdict: ok, or the error message the buyer sees. */
export type CartVerdict = { ok: true } | { ok: false; error: string };

/** What the gate reads from one submitted cart: the page context, the
 * submitted form, the fold's base, and the active holidays. */
export type CartJudgement = {
  base: FoldBase;
  ctx: JudgeCartCtx;
  form: FormParams;
  holidays: Holiday[];
};

/** The cart context slice the judge reads. */
export type JudgeCartCtx = Pick<
  TicketCtx,
  "childrenByParentId" | "listings" | "packages"
>;

/** One in-cart option's question: the parents one selection books, their
 * required children, the units per parent, the chosen date, and the
 * buyer's explicit child choices. */
const questionOf = (
  { base, ctx, form, holidays }: CartJudgement,
  parents: readonly TicketListing[],
  isPackage: boolean,
): OptionDemandQuestion => ({
  childrenByParentId: ctx.childrenByParentId,
  choices: form,
  date: base.date,
  holidays,
  isPackage,
  parents,
  quantities: base.quantities,
});

/** Why the gate refuses: the option's own name for the walk's sold-out
 * message. A package names its first member, as the walk's fold errors do.
 * Every judged option carries at least one parent. */
const optionName = (parents: readonly TicketListing[]): string => {
  const first = requireValue(parents[0], "A judged option has no parents");
  return first.listing.name;
};

/** Ask the judge about every option the buyer is booking. A refusal that the
 * walk cannot name refuses the cart. That class holds a closed or sold-out
 * option, a span or date no child serves, and no bookable child. A capacity
 * refusal is left to the walk and the SQL. */
export const judgeSubmittedCart = ({
  base,
  ctx,
  form,
  holidays,
}: CartJudgement): CartVerdict => {
  const members = packageMemberIds(ctx.packages);
  const inCart = (info: TicketListing): boolean =>
    (base.quantities.get(info.listing.id) ?? 0) > 0;
  const standalone = ctx.listings
    .filter((info) => !members.has(info.listing.id) && inCart(info))
    .map((info) => [info]);
  const packages = ctx.packages
    .filter((pkg) =>
      pkg.memberListingIds.some((id) => (base.quantities.get(id) ?? 0) > 0),
    )
    .map((pkg) =>
      ctx.listings
        .filter((info) => pkg.memberListingIds.includes(info.listing.id))
        .map((info) => info),
    );
  for (const [parents, isPackage] of [
    ...standalone.map((parents) => [parents, false] as const),
    ...packages.map((parents) => [parents, true] as const),
  ]) {
    const verdict = judgeOptionDemand(
      questionOf({ base, ctx, form, holidays }, parents, isPackage),
    );
    if (
      verdict.outcome.state === "refused" &&
      verdict.outcome.reason !== "capacity"
    ) {
      return {
        error: t("public.ticket.child_sold_out", {
          name: optionName(parents),
        }),
        ok: false,
      };
    }
  }
  return { ok: true };
};
