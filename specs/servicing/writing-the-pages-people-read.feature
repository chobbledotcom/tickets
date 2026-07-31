@story:servicing.writing-the-pages-people-read
@owner:servicing @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner writes the pages people read
  Besides the things it sells, a site has pages that simply say something — how
  to find us, what to bring, who we are. The owner writes those pages
  themselves, chooses the web address each one lives at, and decides the order
  they are offered in. A page is live as soon as it is written, so anyone can
  read it straight away.

  @rule:servicing.a-page-written-is-a-page-anybody-can-read
  @surface:public
  Rule: A page written is a page anybody can read
    There is no separate step to publish. The owner writes it, and it is there
    at the address they chose — for a visitor who was never signed in and never
    will be.

    @case:site-pages.written-and-readable
    Scenario: The owner writes a page
      Given the owner is writing the site's pages
      When the owner writes a page called Directions at "how-to-find-us"
      Then the owner is told it saved
      And a visitor reading "how-to-find-us" is shown Directions

  @rule:servicing.two-pages-cannot-share-an-address
  Rule: Two pages cannot share an address
    An address points at one page. The site refuses a second page at an address
    already taken, and refuses the addresses it keeps for itself — otherwise a
    page could quietly shadow a part of the site nobody meant to replace.

    @case:site-pages.address-already-taken
    Scenario: The owner reuses an address
      Given the owner has written a page called Directions at "how-to-find-us"
      When the owner writes a page called Parking at "how-to-find-us"
      Then the owner is told that will not do
      And the site has no page called Parking
      And a visitor reading "how-to-find-us" is shown Directions

    @case:site-pages.address-the-site-keeps
    Scenario: The owner takes an address the site keeps for itself
      Given the owner is writing the site's pages
      When the owner writes a page called Sneaky at "admin"
      Then the owner is told that will not do
      And the site has no page called Sneaky

  @rule:servicing.the-owner-decides-what-order-the-pages-come-in
  Rule: The owner decides what order the pages come in
    Pages are offered in the order the owner puts them, and they move them one
    step at a time. Asking to move the top page up does nothing, rather than
    failing or wrapping it round to the bottom.

    @case:site-pages.moved-into-order
    Scenario: The owner rearranges the pages
      Given the owner has written pages called Directions, Parking and Opening
      When the owner moves Parking up
      Then the pages are offered in the order Parking, Directions and Opening
      Then Parking is already at the top

  @rule:servicing.a-page-can-be-taken-down
  Rule: A page can be taken down
    Taking a page down is deliberate — the owner types its name to confirm —
    and once it is gone the address stops answering, so nothing is left half
    removed for a visitor to stumble into.

    @case:site-pages.taken-down
    Scenario: The owner takes a page down
      Given the owner has written a page called Directions at "how-to-find-us"
      When the owner takes down the page called Directions
      Then reading "how-to-find-us" leads nowhere

    @case:site-pages.wrong-name-changes-nothing
    Scenario: The owner types the wrong name
      Given the owner has written a page called Directions at "how-to-find-us"
      When the owner tries to take down Directions by typing Parking
      Then the owner is told the page name does not match
      And a visitor reading "how-to-find-us" is shown Directions
