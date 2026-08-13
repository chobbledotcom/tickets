@story:payments.resolving-uncertain-refunds
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The owner resolves a refund the site cannot safely decide
  A lost provider answer must never become a guessed success or an automatic
  repeat. The owner checks the provider, makes one required choice, and the
  site keeps any remaining work visible until it is truly finished.

  @rule:payments.ready-refund-intents-have-a-reachable-exit
  @surface:admin
  Rule: A refund intent waiting to start stays reachable
    A callback may record the exact refund intent without sending it. The owner
    can reach that work from Privacy and ask the one refund process to continue;
    the browser does not contain a second refund implementation.

    @case:refund-authority.owner-continues-ready-sumup-intent
    Scenario: The callback recorded a SumUp refund intent before sending it
      Given a SumUp refund intent is ready but has not been sent
      When the owner opens Privacy
      Then the refund is listed without exposing its provider reference
      When the owner opens the listed refund
      Then the ready refund has one clearly marked Send control
      When the owner sends the ready refund
      Then SumUp receives exactly one refund attempt
      And the current page asks for the returned money to be recorded in Money

  @rule:payments.owner-can-authorise-one-new-keyless-generation
  @surface:admin
  Rule: A confirmed unsent refund gets one new attempt
    The owner must reach the case from Privacy and choose what the provider
    really says. Saving that choice authorises work; it does not send money
    from the browser request.

    @case:refund-authority.owner-authorises-one-new-sumup-attempt
    Scenario: SumUp confirms that its lost refund was never sent
      Given a SumUp refund lost its answer and now needs the owner
      When the owner opens Privacy
      Then the refund is listed without exposing its provider reference
      When the owner opens the listed refund
      Then the provider reference is shown with two required unanswered choices
      When the owner chooses that no refund was sent
      Then saving the choice sends no second refund
      And the newly authorised attempt remains reachable in the owner queue
      When the refund process continues from that authority
      Then SumUp receives one newly authorised refund attempt

  @rule:payments.returned-money-work-has-an-explicit-exit
  @surface:admin
  Rule: Known returned money stays visible until Money is recorded
    Saying that the provider returned the money is not the same as recording
    that return locally. The second obligation remains visible and has its own
    specific confirmation rather than a generic clear button.

    @case:refund-authority.owner-finishes-returned-money-recording
    Scenario: SumUp confirms that its lost refund returned the money
      Given a SumUp refund lost its answer and now needs the owner
      When the owner opens Privacy
      And the owner opens the listed refund
      And the owner chooses that the money was returned
      Then saving the choice sends no second refund
      And the returned money still asks to be recorded in Money
      When the owner confirms that the returned money is recorded in Money
      Then the resolved case leaves the owner queue
      And SumUp still received only its original refund attempt
