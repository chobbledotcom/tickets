@story:settings.connecting-an-email-provider
@owner:settings @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
@surface:admin
Feature: The owner connects the site to an email provider
  The site does not send email of its own. It hands each message to a provider
  the owner has an account with, so nothing reaches an attendee until the owner
  has named that provider, given it a key, and said which address the mail goes
  out from. A key cannot be read back once it is saved, so the owner is never
  asked to type it again to change something else. A test send tells the owner
  what really happened, in the provider's own words when it has any, because a
  provider that quietly refuses is how an owner finds out weeks later that
  nobody was told anything.

  @rule:email.the-owner-names-a-provider-and-is-told-it-is-kept
  Rule: The owner connects a provider, and what they gave is kept
    The page offers the choice of provider, a box for the key, and a box for
    the address mail goes out from. What the owner saves is stored, they are
    told so, and the change is written to the activity log.

    @case:email.the-page-offers-the-connection
    Scenario: The owner opens their advanced settings
      When the owner opens their advanced settings
      Then the page offers to connect an email provider

    @case:email.connecting-a-provider
    Scenario: The owner connects a provider
      When the owner connects "resend" sending from "tickets@example.com"
      Then the owner is told the email settings were updated
      And the site is set to send through "resend" from "tickets@example.com"
      And the key the owner typed is the one on file
      And the activity log says the email settings were updated

  @rule:email.changing-the-provider-keeps-the-key-already-given
  Rule: Leaving the key box empty keeps the key already given
    A saved key is never shown back to the owner. The site cannot ask for it
    again, because the owner cannot see what to type. An empty key box means
    "leave it as it is", not "forget it".

    @case:email.switching-provider-without-retyping-the-key
    Scenario: The owner changes provider and leaves the key box empty
      Given the site sends through "resend" from "from@example.com"
      Then the from-address box still shows "from@example.com"
      When the owner changes the provider to "postmark", filling nothing else in
      Then the owner is told the email settings were updated
      And the site is set to send through "postmark" from "from@example.com"
      And the key the owner gave earlier is still the one on file

  @rule:email.choosing-no-provider-disconnects-and-forgets
  Rule: Choosing no provider disconnects the site and forgets the key
    Turning email off means the site holds no credentials for a provider it no
    longer uses, so the key and the address go with it.

    @case:email.disconnecting-the-provider
    Scenario: The owner turns email off
      Given the site sends through "resend" from "from@example.com"
      When the owner chooses no provider at all
      Then the owner is told the email provider was disabled
      And the site is not set to send anything

  @rule:email.there-is-no-test-to-send-until-there-is-somewhere-to-send-it
  Rule: There is no test to send until there is somewhere to send it
    A test needs a provider to send through and a business email to send to.
    Without a provider the page offers no test at all, rather than a button
    that can only fail.

    @case:email.no-test-button-before-a-provider-is-connected
    Scenario: The owner looks before connecting anything
      When the owner opens their advanced settings
      Then there is no way to send a test email

    @case:email.the-test-button-appears-once-connected
    Scenario: The owner looks after connecting a provider
      Given the site sends through "resend" from "from@example.com"
      When the owner opens their advanced settings
      Then the page says the site sends through "resend"
      And there is a way to send a test email

    @case:email.a-test-with-nobody-to-send-it-to
    Scenario: The owner sends a test with no business email set
      Given the site sends through "resend" from "from@example.com"
      When the owner sends a test email
      Then the owner is told no business email is set

  @rule:email.a-test-send-says-what-really-happened
  Rule: A test send says what really happened
    The owner is told the provider took it, or that it failed and why. Where
    the provider gave a reason, that reason is repeated word for word, because
    it is the only thing that says how to put the problem right. A provider
    that wraps its reason in its own format is unwrapped, so the owner reads
    the sentence rather than the envelope around it.

    @case:email.a-test-that-goes
    Scenario: The provider takes the test email
      Given the site can send email to the owner
      When the owner sends a test email
      Then the owner is told the test email was sent

    @case:email.a-test-the-provider-refuses
    Scenario: The provider refuses the test email
      Given the site can send email to the owner
      And the provider refuses with 403 and says "Forbidden"
      When the owner sends a test email
      Then the owner is told the test failed with 403 because "Forbidden"

    @case:email.a-provider-that-explains-itself-in-its-own-format
    Scenario: The provider explains itself in its own format
      Given the site sends through "sendgrid" from "from@example.com"
      And the owner has a business email
      And sendgrid refuses with 403, explaining "The from address does not match a verified Sender Identity"
      When the owner sends a test email
      Then the owner is told the test failed with 403 because "The from address does not match a verified Sender Identity"

    @case:email.a-test-refused-with-no-words
    Scenario: The provider refuses and says nothing
      Given the site can send email to the owner
      And the provider refuses with 403 and says nothing
      When the owner sends a test email
      Then the owner is told the test failed with 403, and no reason

    @case:email.a-provider-that-never-answers
    Scenario: The provider does not answer at all
      Given the site can send email to the owner
      And the provider never answers
      When the owner sends a test email
      Then the owner is told the test failed with no response
