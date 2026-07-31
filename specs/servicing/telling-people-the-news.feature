@story:servicing.telling-people-the-news
@owner:servicing @risk:low
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner tells people the news
  The site keeps a news page. The owner writes a post in the admin, and a
  visitor reads it at the post's own address. The News link only appears
  once there is something to read, so nobody is led to an empty page.

  @rule:servicing.a-post-is-read-at-its-own-address
  @surface:public
  Rule: A post is read at its own address
    Creating a post is confirmed to the owner, and a visitor who was never
    signed in reads its words — on the news page, and on the page the news
    page links the post to.

    @case:news.write-and-read-a-post
    Scenario: The owner posts news and a visitor reads it
      Given the public site is on
      When the owner posts news called "Big launch" saying "Doors open Friday."
      Then the owner is told the news post was created
      And a visitor on the news page reads "Big launch"
      And a visitor following "Big launch" from the news page reads "Doors open Friday."

  @rule:servicing.the-news-link-waits-for-the-first-post
  @surface:public
  Rule: The news link waits for the first post
    Before any post exists, the news page finds nothing and no public page
    offers a News link. The first post brings both to life.

    @case:news.no-posts-no-link
    Scenario: There is no news yet
      Given the public site is on
      Then a visitor on the front page is offered no News link
      And a visitor asking for the news page finds nothing there

    @case:news.first-post-brings-the-link
    Scenario: The first post brings the link
      Given the public site is on
      When the owner posts news called "We have opened" saying "Come and see us."
      Then a visitor on the front page is offered a News link

  @rule:servicing.taking-a-post-down-needs-its-exact-name
  @surface:public
  Rule: Taking a post down needs its exact name
    Deleting a post asks the owner to type its name. A wrong name leaves the
    post standing; the exact name removes it, and with the last post gone the
    news page finds nothing again.

    @case:news.wrong-name-keeps-the-post
    Scenario: The owner types the wrong name
      Given the public site is on
      And the owner has posted news called "Spring fair"
      When the owner tries to take down "Spring fair" typing "Spring fete"
      Then the owner is told the post name does not match
      And a visitor on the news page still reads "Spring fair"

    @case:news.exact-name-removes-the-post
    Scenario: The owner types the exact name
      Given the public site is on
      And the owner has posted news called "Spring fair"
      When the owner takes down "Spring fair" typing its exact name
      Then the owner is told the news post was deleted
      And a visitor asking for the news page finds nothing there
