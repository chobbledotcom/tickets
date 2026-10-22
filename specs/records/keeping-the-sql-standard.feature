@story:records.keeping-the-sql-standard
@owner:records @risk:low
@actor:developer
@edition:managed @edition:self-hosted
Feature: The site's code keeps to the SQL standard
  The code-quality job reads every source file and fails, naming the file and
  the line, when a SQL statement binds one value more than once. It fails the
  same way when SQL text spells a numbered parameter by hand.

  @rule:records.a-repeated-bind-fails-with-its-location
  Rule: A statement that binds one value twice fails the job, naming the line
    The numbered builder binds a value once and reuses its token, so a
    statement that binds one value twice is exactly the drift the job exists
    to catch. Its report names the file and the line to fix.

    @case:code-standard.a-repeated-bind-fails-with-its-location
    Scenario: The job reports a repeated bind
      When the code-quality job reads a statement that binds the same value twice
      Then the job fails, naming the file and the line of the repeated value

  @rule:records.a-hand-numbered-parameter-fails-with-its-location
  Rule: SQL text that writes a numbered parameter itself fails the job
    The numbered builder is the only writer of numbered parameters, so SQL
    text spelling one by hand is drift too. Its report names the file and the
    line to fix.

    @case:code-standard.a-hand-numbered-token-fails-with-its-location
    Scenario: The job reports a hand-numbered parameter
      When the code-quality job reads SQL text that spells a numbered parameter itself
      Then the job fails, naming the file and the line of the parameter

  @rule:records.builder-code-passes-the-job
  Rule: A statement built through the numbered builder passes the job
    The standard's own shape binds each value once through the builder, so the
    job passes it without a word.

    @case:code-standard.builder-code-passes
    Scenario: The job passes a statement built through the numbered builder
      When the code-quality job reads a statement built through the numbered builder
      Then the job passes it

  @rule:records.the-current-tree-passes-the-job
  Rule: The site's own source passes the job
    The job runs over the site's real source tree, with the allowances the
    code-standard keeps. A tree that drifts would fail here.

    @case:code-standard.the-tree-passes
    Scenario: The job passes every source file the site has
      When the code-quality job reads every source file the site has
      Then the job passes them all

  @rule:records.the-allowed-assembly-alone-is-accepted
  Rule: The allowed clause assembly passes while its neighbour fails
    One clause assembly cannot convert alone, so the code-standard allows it
    by name. The allowance covers that declaration only: another assembly in
    the same file that binds one value twice still fails, naming its own line.

    @case:code-standard.only-the-allowed-assembly-passes
    Scenario: The allowed assembly passes and its neighbour is named
      When the code-quality job reads the allowed clause assembly binding its parts twice
      Then the job passes it
      When the code-quality job reads the same file with another assembly binding one value twice
      Then the job names the neighbouring assembly's line
