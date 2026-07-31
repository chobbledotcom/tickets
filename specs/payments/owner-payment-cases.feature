@story:payments.owner-payment-cases
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An owner resolves a payment that needs a human decision
  Some payment facts cannot be settled safely without the owner.
  The owner must see the facts and make every genuine choice themselves.

  @rule:payments.owner-chooses-genuine-conflict
  Rule: The owner chooses how a genuine payment conflict is settled
    The system carries out the chosen action through the normal payment process.

    @case:payment.owner-refunds-every-charge
    Scenario: Refund all money across several charges
      Given a payment with two charges needs the owner's decision
      When the owner chooses to refund all money still held
      Then both charges are fully refunded

    @case:payment.owner-confirms-full-refund
    Scenario: Confirm a full refund already proved elsewhere
      Given a full refund needs the owner's confirmation
      When the owner confirms the full refund
      Then every charge is recorded as fully refunded

    @case:payment.owner-assigns-older-provider
    Scenario: Assign an older payment to a configured payment service
      Given an older payment has an unclear payment service record
      When the owner assigns the configured payment service
      Then the older payment is attached and resolved

  @rule:payments.owner-must-choose
  Rule: A payment case never has a default decision
    The form must fail closed until the owner makes an explicit choice.

    @case:payment.owner-choice-required
    Scenario: Submit a payment case without choosing
      Given a payment case requires the owner's decision
      When the owner submits the case without choosing a decision
      Then the case asks the owner to choose a decision

  @rule:payments.stale-owner-decision-is-rejected
  Rule: A decision applies only to the facts the owner reviewed
    A changed case must be reviewed again before money or bookings change.

    @case:payment.owner-stale-revision
    Scenario: The case changes after the owner opens it
      Given the owner opened a payment case before its facts changed
      When the owner submits the older decision
      Then no payment action is carried out
      And the owner is asked to review the latest facts

  @rule:payments.payment-cases-are-owner-only
  Rule: Other admin roles cannot see payment cases
    Money conflict choices belong to the owner alone.

    @case:payment.manager-cannot-see-cases
    Scenario: A manager opens the admin area while a payment case is waiting
      Given a manager is signed in while a payment case is waiting
      When the manager checks the admin area and payment cases
      Then no payment case link or page is visible
