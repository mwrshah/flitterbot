# Recall Triggers and Individual Learning Labels

## Structure

The learning system has two levels of matching:

1. A **Recall Trigger** in `~/.flitterbot/data/MEMORY.md` tells the agent when to recall a Situation Group.
2. An **Individual Learning Label** tells the agent when one Individual Learning Bullet within that group applies.

An Individual Learning Bullet has this form:

```text
- {Situation Code}-{Individual Learning Label}: {Content}
```

The Recall Trigger recognizes the Situation Group. The Individual Learning Label selects a bullet from that group. The Content says what to do.

## Writing a Recall Trigger

A Recall Trigger describes the evidence that should cause the agent to load a Situation Group. Write what the agent may encounter in the user request, tool output, repository, or workflow state.

A good Recall Trigger:

- can be recognized before the group is recalled
- names observable wording, artifacts, events, results, or state
- includes concrete manifestations when the user will not name the underlying category
- covers every Individual Learning Bullet assigned to the Situation Code
- excludes unrelated work well enough to avoid routine false recalls
- contains no instruction, remedy, answer, or summary of the hidden Content

Prefer direct evidence such as:

- phrases or references in the user's request
- filenames, paths, prefixes, or marker files
- commands or operations requested by the user
- error names, status values, and tool output
- repository or workflow state that the agent has already observed

Do not rely on a diagnosis that the agent could reach only after recalling the learning. Replace abstract categories with the way those categories present themselves.

Weak:

```text
when working with Obsidian
```

Better:

```text
when the user references a note by type or filename prefix, such as `Project -`, `Ref -`, `Insight -`, `Prompt -`, or `YYYY-MM-DD Journal`
```

Weak:

```text
when a dependency policy causes a problem
```

Better:

```text
when pnpm reports `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, or a package install fails after a dependency swap in a pnpm workspace
```

### Recall Trigger acid test

Ask:

> Could an agent that has not loaded this Situation Group determine from the current context that the group might be relevant?

Check each part:

1. **Available evidence:** The triggering evidence exists in the current request, tool output, files, or established workflow state.
2. **Observer agreement:** Two agents could agree whether the trigger occurred.
3. **Pre-recall recognition:** Recognizing the trigger does not require guidance stored behind the trigger.
4. **Group coverage:** The trigger can reach every Individual Learning Bullet assigned to the Situation Code.
5. **Boundary:** The wording does not pull in a large class of unrelated work.
6. **No response leakage:** The trigger says when to recall, without saying what to do.

Optimize for reliable recall. A Recall Trigger only needs to establish that the Situation Group might contain relevant guidance.

## Writing an Individual Learning Label

An Individual Learning Label states the narrower condition under which one bullet's Content applies. The group has already been recalled, so the label should help the agent choose among sibling bullets.

A good Individual Learning Label:

- names the specific phase, event, subtype, or state in which the Content applies
- distinguishes the bullet from others under the same Situation Code
- uses observable or already-established facts
- describes applicability rather than the prescribed response
- avoids repeating the whole Recall Trigger unless repetition removes ambiguity
- remains short enough to scan as a label

Prefer labels such as:

```text
pnpm minimum-release-age failure
after a merge preview resolves the target
merge preview has no resolved target
spoken note-type reference
ambiguous note filename
```

Avoid labels such as:

```text
dependencies
error
closing streams
do the merge correctly
```

The first three name broad topics and do not select a subcase. The last one states a desired response rather than an applicability condition.

### Individual Learning Label acid test

Ask:

> After recalling the Situation Group, could the agent determine whether this bullet applies without first following its Content?

Check each part:

1. **Sibling distinction:** The label separates this bullet from the other bullets in the group.
2. **Applicable condition:** The label identifies when the Content applies.
3. **Known evidence:** The condition is visible or has already been established.
4. **No instruction:** The label does not tell the agent what action to take.
5. **Useful brevity:** Removing more words would make the label ambiguous; adding more would repeat the trigger or Content.

## Final review

Read the three parts on their own:

```text
Recall Trigger -> Should I load this Situation Group?
Individual Learning Label -> Does this bullet apply now?
Content -> What should I do?
```

If one part answers another part's question, rewrite it so each level has one job.
