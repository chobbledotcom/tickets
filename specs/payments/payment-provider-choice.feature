@story:payments.provider-choice
@owner:payments @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser chooses a payment provider
  An organiser can switch between supported payment providers.
  A saved provider setup remains available when selected again.

  @rule:payments.saved-provider-can-be-selected
  Rule: A saved test setup remains available after switching providers
    Selecting a provider makes it active without removing its saved key.

    @case:payments.select-saved-stripe
    Scenario: The organiser switches back to a saved Stripe test setup
      Given a Stripe test key is saved while Square takes payments
      When the organiser changes the payment provider to Stripe
      Then the payment settings show Stripe selected with its saved key in test mode

  @rule:payments.existing-provider-recovery-keeps-sales-off
  Rule: Choosing the provider for existing payments does not restart sales
    When saved settings do not show which provider took earlier payments, the
    organiser must choose one. This choice is only for those earlier payments.

    @case:payments.recover-existing-provider
    Scenario: The organiser chooses Stripe for existing payments
      Given Stripe and Square were configured before new sales were turned off
      When the organiser opens the payment settings
      Then the organiser must choose the provider for existing payments
      When the organiser chooses Stripe for existing payments
      Then new sales stay off and the saved Stripe settings remain available

  @rule:payments.provider-recovery-blocks-custom-domain
  Rule: A custom domain cannot change before provider recovery is complete
    A domain change also changes payment callback addresses. The organiser must
    first say which provider still owns existing payments.

    @case:payments.recovery-blocks-custom-domain
    Scenario: The organiser recovers the provider before changing a custom domain
      Given provider recovery is needed and both domain options are available
      When the organiser opens the domain settings
      Then custom domain changes are unavailable until a provider is chosen
      When the organiser chooses Stripe for existing payments
      Then custom domain changes are available again

  @rule:payments.provider-recovery-blocks-host-subdomain
  Rule: A host subdomain cannot be registered before provider recovery is complete
    The organiser may check a name, but cannot register it until the provider
    for existing payments is known.

    @case:payments.recovery-blocks-host-subdomain
    Scenario: The organiser recovers the provider before registering a host subdomain
      Given provider recovery is needed and both domain options are available
      When the organiser checks whether the host subdomain "mylisting" is available
      Then host subdomain registration is unavailable until a provider is chosen
      When the organiser chooses Stripe for existing payments
      And the organiser checks whether the host subdomain "mylisting" is available
      Then host subdomain registration is available again
