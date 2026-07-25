# Classification Help

Classification decides whether a new Individual Learning Bullet belongs to an existing Situation Group or needs a new Situation Code and Recall Trigger.

## Default rule

Reuse an existing Situation Code when the same Recall Trigger should retrieve both the existing bullets and the new bullet.

Mint a new Situation Code when retrieving the existing group would be too broad, too narrow, or dependent on a different kind of evidence.

Classify by the situation that should cause recall, not by the lesson's topic, prescribed action, tool, or implementation detail.

## Decision process

### 1. State the candidate situation without the lesson

Write one sentence describing only what the agent encounters. Remove the remedy and the user's preferred response.

Example:

```text
The user asks for follow-up work on a PR previously raised by the agent.
```

Do not classify from a sentence such as:

```text
Fetch the comments and address every valid review finding.
```

The second sentence is Content, not a situation.

### 2. Compare the candidate with existing Recall Triggers

For each plausible Situation Code, ask:

> Would the existing Recall Trigger fire for this candidate without being stretched or reinterpreted?

If yes, inspect the group's Individual Learning Bullets. Reuse the code when the candidate is another rule for the same recalled situation.

Examples that usually belong together:

- setup, execution, validation, and recovery instructions for the same operation
- different failure modes encountered during the same workflow
- output and communication preferences for the same request type
- guidance for separate phases that share one recognizable entry condition

### 3. Test the reverse direction

Ask:

> If the Recall Trigger were rewritten to include this candidate, would it still describe one coherent situation family?

A shared noun is not enough. Two learnings about Git, Python, logging, or configuration may require different triggers because the agent encounters them in different circumstances.

Keep one group when a single natural Recall Trigger reaches all bullets. Split when the trigger becomes a list of unrelated reasons joined only by "or."

### 4. Decide whether the difference belongs in the label

Reuse the Situation Code when the difference can be expressed as an Individual Learning Label after the group is recalled.

For example, one stream-closing group can contain labels such as:

```text
after the merge preview resolves the target
merge preview has no resolved target
pre-commit hook changes files during close
```

These are subcases of one workflow. They need separate bullets, not separate Recall Triggers.

### 5. Mint only when recall needs a separate entry condition

Create a new Situation Code and Recall Trigger when one or more of these are true:

- the candidate is recognized through different evidence
- it can occur independently of the existing group's situation
- loading the existing group for the candidate would produce mostly irrelevant guidance
- adding it would make the existing Recall Trigger vague or misleading
- the candidate has its own coherent set of present or likely future bullets
- the existing group describes an adjacent topic rather than the same triggering situation

Do not mint a code merely because the new Content differs from existing Content. Multiple instructions are the reason Situation Groups exist.

## Reuse, split, or reconcile

### Reuse the Situation Code

Reuse when:

- the existing Recall Trigger already covers the candidate
- the new bullet adds a distinct instruction for that situation
- an Individual Learning Label can identify its narrower applicability

Before adding, check the group for duplicates and contradictions.

### Split into a new Situation Code

Split when:

- the candidate needs a different Recall Trigger
- the old trigger would need unrelated clauses to cover it
- recalling both sets together would reduce selection accuracy

Write the new Recall Trigger from observable evidence, then assign a fresh Situation Code.

### Reconcile with an existing bullet

Do not add another bullet when the candidate:

- repeats an existing instruction
- narrows or clarifies an existing rule without creating a separate applicability condition
- conflicts with an older rule that the new instruction supersedes

Update the existing Individual Learning Bullet so one canonical instruction remains.

## Classification acid tests

Use these questions in order:

1. **Same recall test:** Should the same evidence recall both learnings?
2. **Independent occurrence test:** Can either situation occur without the other?
3. **Sibling-label test:** Can a short Individual Learning Label separate the new subcase after recall?
4. **Coherence test:** Can one natural Recall Trigger describe the whole group?
5. **Relevance test:** When recalled, will a useful share of the group's bullets concern the current situation?
6. **Duplication test:** Is this a new instruction, rather than a restatement or correction of an existing bullet?

Interpretation:

- Same recall plus a clear sibling label means reuse the Situation Code.
- Different recall evidence or independent situation families means mint a new code.
- Duplicate, clarification, or superseding guidance means reconcile the existing bullet.

## Common classification mistakes

### Grouping by tool or technology

"Uses Git" or "involves pnpm" is too broad. Group by the request or event that should trigger recall.

### Grouping by desired action

"Need to inspect first" describes a response. Classify by the situation that makes inspection necessary.

### Minting for every new lesson

A Situation Code groups multiple bullets. New Content does not imply a new trigger.

### Forcing adjacent situations together

Similar vocabulary does not prove shared recall. A PR review, follow-up work on a PR, and creating a PR have different entry conditions even though all involve pull requests.

### Using an inferred root cause as the situation

Classify from evidence available at recall time. If the agent sees a specific error before it knows the cause, use the error or operation as the trigger rather than the eventual diagnosis.

## Output of classification

Classification should produce one of three decisions:

```text
Reuse {Situation Code}: {reason the existing Recall Trigger covers it}
Mint new Situation Code: {observable Recall Trigger}
Reconcile {Situation Code}-{Individual Learning Label}: {duplicate, clarification, or superseding rule}
```

State the decision before writing or changing an Individual Learning Bullet.
