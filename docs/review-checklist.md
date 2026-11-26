# Pull request review checklist

Assign checks to parallel workers. Give each worker only its assigned checks
and files. Cover every changed file with each applicable check. If a check
crosses file boundaries, read the related callers and declarations.

Start with parallel implementations. Report each finding with a file and line,
the state or input that exposes the problem, its effect, and the preferred fix.

## Shared design

1. **Declare the cases once.** Repeated keys, fields, and variants signal
   parallel implementations even when each caller does different work with the
   values. If you add, rename, or remove one case, how many independent
   declarations must change? Can you miss one and still pass typecheck? Put
   shared facts in one typed schema. Derive the views from that schema. Use a
   factory where callers repeat the construction. Make behaviour that differs
   by case exhaustive over the shared keys.
2. **Reuse the rule, not just its parts.** If two paths ask the same domain
   question, can they give different answers after one rule change? Find the
   existing rule and make both paths call it.
3. **Preserve differences that callers rely on.** If you merge two helpers,
   which differences belong to the caller's contract? Pass the difference as
   an input instead of silently giving both callers one behaviour.
4. **Make structural drift a type error.** If a dependency adds an operation,
   can that operation bypass the wrapper? Derive its names and signatures from
   the interface that it wraps.
5. **Give each export a live caller.** Who reads the export in production? If
   only tests or the same file read it, remove the export or move the helper
   to the tests.
6. **Remove the old path at cutover.** After a change or merge, do any callers
   still use the local copy? Check production code, test setup, and obsolete
   entry points.
7. **Load code where it runs.** Does a feature add code to a shared bundle
   that pages without the feature also receive? Keep the dependency at the
   narrowest entry point that uses it.
8. **Distinguish valid states before you read their fields.** Can a field hold
   different facts in different states? Classify the record first. Read only
   the fields that belong to that state.

## Boundaries and authority

9. **Validate external data at its point of entry.** Does the first reader
   check the complete shape, or do later callers each guess what arrived?
   Parse once and pass the typed result.
10. **Do not manufacture a value for an invariant.** If the caller already
    proves that a value exists, why does the next function have a fallback?
    Make the guarantee explicit. Do not turn a broken invariant into valid data.
11. **Keep failure classes distinct.** Can a refusal, a local fault, and a
    connection failure all appear as the same outcome? Preserve the distinction
    if it changes the next action or the message.
12. **Prove that a test reaches the authority check.** Does the denied request
    pass validation up to the gate in question? Use a valid request and show
    that the same request works for an allowed actor.
13. **Put required side effects at the authoritative boundary.** Can a caller
    obtain the result without the required audit or other side effect? Attach
    it to the operation that grants the result.
14. **Bind delegated authority to its context.** Can a credential for one actor,
    resource, or step authorise another? Verify the scope and lifetime when
    the credential is used.
15. **Limit sensitive data to the task.** What does the ordinary request read,
    decrypt, send, and retain? Give a lookup only what it needs. Keep bulk
    access a separate, deliberate action.
16. **Keep secrets out of diagnostics.** Can a lower layer include a secret
    in a value or error that the caller logs? Check the final output on the
    success and failure paths.

## Time, races, and failure

17. **Put the guard inside the write.** Can another request change a fact
    after the check but before the write? Repeat the condition in the atomic
    operation and verify that a conflict leaves the full state intact.
18. **Commit facts that must coexist together.** What state remains if work
    stops between two writes? Put the writes in one transaction if either
    result is invalid without the other.
19. **Protect new work from old work.** Can cancellation, cleanup, or a late
    callback from one operation change the state of its replacement? Tie the
    update to the operation that owns the state.
20. **Keep replay protection after temporary state expires.** What happens if
    the same event arrives after cleanup? Check that durable facts still stop
    duplicate effects.
21. **Treat separate cleanup operations as independent.** If either delete can
    run first, what can the system see between them? Test both orders and any
    valid state in which one record survives.
22. **Tie retention to the authority that ends the operation.** Can external
    work still succeed after local expiry? Keep the facts needed to finish
    until the external operation ends and its replay window closes.
23. **Do not infer that one action ends a separate obligation.** After repair,
    what external work can still happen? Name the action that stops it and
    who must take that action.
24. **Treat expected transition states as such.** Can a documented temporary
    response abort a lifecycle step and leave the system stuck? Distinguish it
    from a terminal failure and make the final diagnostic specific.

## Data and resource costs

25. **Carry the full identity across transformations.** Can two rows share
    the key that a join, group, merge, or export uses? Test two records that
    differ only in the omitted part of the identity.
26. **Enforce uniqueness where lookup assumes it.** Can two valid writes
    create two answers to a lookup that expects one? Use the same scope on
    the read and the write.
27. **Project writable fields explicitly.** Can a read add computed fields
    that flow into an insert or update? Copy only the stored fields that the
    destination accepts.
28. **Distinguish omission from an explicit change.** Can a sparse update
    erase a value or issue a write with no fields? Check empty input, omitted
    values, and values that request a clear.
29. **Account for indirect deletion.** What else disappears when a valid edit
    removes a row? Check the cascade and require a choice if the action can
    destroy data that the request did not name.
30. **Read historical data on its own terms.** Can valid deletion of a related
    record break a historical view? Preserve the history without a dependency
    on current labels or records.
31. **Check new code with old records and requests.** Do the parser, database
    rules, and application agree on a fact that older data omits? Check that
    compatibility does not admit malformed data.
32. **Make direct data changes visible to warm readers.** If a migration or
    batch bypasses the usual writer, what invalidates cached results? Verify the
    next read from a reader that already holds the old data.
33. **Count remote work as the collection grows.** Does one list item cause
    one database or provider call? Measure the cost with enough rows to expose
    a repeated read and keep it within the request budget.
34. **Preserve the basis and the total of an allocation.** Does the split use
    the same unit as the rule that produced the amount? Check unequal parts
    and exact rounding. Verify that the parts add up to the original amount.

## User and caller contracts

35. **Check that each layer enforces the same input rule.** If a form, API,
    or database accepts a different set of values, which one defines the
    contract? Derive each layer's rule from the shared contract where possible.
    If the layers need separate rules, test that they agree at the limits.
36. **Check the whole response contract.** What does a caller rely on besides
    the body? Verify status, content type, and applicable browser or cache
    policy.
37. **Keep creation defaults out of updates.** Does an edit reset order,
    ownership, or another property that only creation sets? Assert what must
    stay the same as well as what changes.
38. **Do not report a write that did not happen.** If the target disappears
    before the write, can side effects or a success event still occur? Test
    the result and the absence of those effects.
39. **Check dynamic UI on the real interaction path.** Does a control work
    after its element is added or moved? Test the sequence that changes the
    DOM, not just the initial markup.
40. **Keep display vocabulary in step with behaviour.** Do the form, refusal,
    and guide use the same name for the same fact? Check variants, not just the
    default case.

## Evidence and regression tests

41. **Make a negative assertion prove that it checked something.** Can an
    absent element, unmatched selector, or empty input make an exclusion test
    pass? Prove that the target exists and that the matcher detects a violation.
42. **Assert the promised outcome, not mere success.** Can the request succeed
    with only part of the expected result? Assert the values, associations,
    side effects, or order that the caller depends on.
43. **Test both sides of a boundary.** Can a test pass if the code rejects all
    input or accepts all input? Check a valid and an invalid case on opposite
    sides of the actual limit. Control time if the limit depends on time.
44. **Wait for the event that proves completion.** Does the test wait for the
    actual result or assume that work finishes after a few turns? Synchronise
    with the state or event that the consumer observes.
45. **Run tests without help from a previous test.** Does a test get its own
    environment and fixtures? Check whether another test can supply setup or
    leak work into this one.
46. **Keep a regression test on the live path.** After a test move or deletion,
    does the remaining test reach the changed behaviour through a real caller?
    Check the refusal paths as well as the successful ones.
47. **Test the production decision, not a copy of it.** If the implementation
    makes the wrong choice, can its model or test still pass? Use an independent
    expected result and run the production rule to obtain the actual result.
48. **Prove that the case under test can occur.** Does any real transition reach
    the state that the test or model claims to cover? Exercise the transition
    and check that an incorrect outcome fails.
