@story:catalogue.the-list-a-visitor-reads
@owner:catalogue @risk:medium
@actor:customer
@edition:managed @edition:self-hosted
@surface:public
Feature: The list a visitor reads
  The public list is where somebody who has never been here before finds what
  they can book. It offers everything on sale, gathers a group under its own
  name, and says how to take each one. It leaves out what nobody can book, and
  it never offers a way in that could only fail.

  @rule:catalogue.the-list-offers-what-is-on-sale-and-says-how-to-take-it
  Rule: The list offers what is on sale, and says how to take it
    Something people attend is offered to book. Something people only buy —
    a raffle ticket, a donation — is offered to buy instead, and never to
    book, because nobody turns up at a door for it.

    @case:visitor-list.something-to-book
    Scenario: A visitor finds something to book
      Given the public site is on
      And the site sells a Concert
      When a customer looks at everything on sale
      Then the list offers the Concert
      And the list says the Concert can be booked

    @case:visitor-list.something-only-to-buy
    Scenario: A visitor finds something that is only bought
      Given the public site is on
      And the site sells a Raffle that nobody attends
      When a customer looks at everything on sale
      Then the list offers the Raffle
      And the list says the Raffle can be bought, not booked

  @rule:catalogue.the-list-leaves-out-what-nobody-can-book
  Rule: The list leaves out what nobody can book
    Something taken off sale is not offered at all. Something the organiser
    keeps off the list stays off it, while the link they hand out themselves
    still works — that is the whole point of keeping it off.

    @case:visitor-list.taken-off-sale
    Scenario: A visitor looks after something is taken off sale
      Given the public site is on
      And the site sells a Concert
      And the Concert is taken off sale
      When a customer looks at everything on sale
      Then the list is empty
      And the list does not offer the Concert

    @case:visitor-list.kept-off-the-list
    Scenario: A visitor looks while something is kept off the list
      Given the public site is on
      And the site sells a Concert
      And the site quietly sells a Secret
      When a customer looks at everything on sale
      Then the list offers the Concert
      And the list does not offer the Secret
      But a customer given the Secret link can still open it

  @rule:catalogue.a-group-is-offered-by-its-own-name
  Rule: A group is offered by its own name
    A group holding something bookable is offered under its own name, with
    whatever the organiser wrote about it, beside the things it holds. A group
    kept off the list stays off it, and its own link still works.

    @case:visitor-list.a-group-and-its-members
    Scenario: A visitor finds a group and the things inside it
      Given the public site is on
      And a Festival group holding a Concert, described as "a weekend of music"
      And the site sells a Workshop
      When a customer looks at everything on sale
      Then the list offers the Festival
      And the list says the Festival is "a weekend of music"
      And the list offers the Concert
      And the list offers the Workshop

    @case:visitor-list.a-group-kept-off-the-list
    Scenario: A visitor looks while a group is kept off the list
      Given the public site is on
      And a quiet Festival group holding a Concert
      When a customer looks at everything on sale
      Then the list does not offer the Festival
      But a customer given the Festival link can still open it

  @rule:catalogue.bundles-are-gathered-above-the-rest
  Rule: Bundles are gathered above the rest
    Things sold together as one bundle are gathered under a heading of their
    own, in name order, above everything else on the list — so a visitor sees
    what is on offer as a whole before the things it is made of.

    @case:visitor-list.bundles-come-first-in-name-order
    Scenario: A visitor reads a list holding two bundles and a group
      Given the public site is on
      And a Weekend bundle holding a Tent
      And a Zephyr bundle holding a Kayak
      And a Festival group holding a Concert
      When a customer looks at everything on sale
      Then the list gathers the bundles first, naming the Weekend before the Zephyr
      And the list puts the Festival below them, under everything on sale

  @rule:catalogue.the-list-never-offers-a-way-in-that-could-only-fail
  Rule: The list never offers a way in that could only fail
    A group whose things are all off sale has no page to send anybody to. A
    bundle is all or nothing, so one part that is full or off sale makes the
    whole bundle unavailable, and a bundle holding nothing has nothing to
    sell. In every case the list stays quiet about it rather than sending a
    visitor somewhere that can only turn them away.

    @case:visitor-list.a-group-with-nothing-on-sale
    Scenario: A group holds nothing that is on sale
      Given the public site is on
      And the site sells a Concert
      And an Empty group holding nothing
      When a customer looks at everything on sale
      Then the list offers the Concert
      And the list does not offer the Empty

    @case:visitor-list.a-bundle-with-a-full-part
    Scenario: A bundle holds a part with no room left
      Given the public site is on
      And the site sells a Concert
      And a Half bundle holding a Tent and a Pitch with no room left
      When a customer looks at everything on sale
      Then the list offers the Concert
      And the list does not offer the Half

    @case:visitor-list.a-bundle-with-a-part-off-sale
    Scenario: A bundle holds a part that is off sale
      Given the public site is on
      And the site sells a Concert
      And a Partial bundle holding a Tent and a Pitch that is off sale
      When a customer looks at everything on sale
      Then the list offers the Concert
      And the list does not offer the Partial

    @case:visitor-list.a-bundle-holding-nothing
    Scenario: A bundle holds nothing at all
      Given the public site is on
      And the site sells a Concert
      And an Empty bundle holding nothing
      When a customer looks at everything on sale
      Then the list offers the Concert
      And the list does not offer the Empty

  @rule:catalogue.the-list-is-only-there-for-a-site-that-is-open
  Rule: The list is only there for a site that is open
    A site whose owner has not opened it to the public has no list to read,
    and sends a visitor to sign in. An open site with nothing for sale says so
    plainly, under the name the owner gave the site.

    @case:visitor-list.the-site-is-not-open-yet
    Scenario: A visitor arrives before the site is opened
      Given the site sells a Concert
      When a customer looks at everything on sale
      Then the customer is asked to sign in instead

    @case:visitor-list.an-open-site-with-nothing-on-it
    Scenario: A visitor arrives at an open site with nothing for sale
      Given the public site is on
      And the site is called "Ada's Workshops"
      When a customer looks at everything on sale
      Then the list is empty
      And the list is headed "Ada's Workshops"
