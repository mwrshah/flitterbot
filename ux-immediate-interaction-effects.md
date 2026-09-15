# The First Hundred Milliseconds

## A treatise on immediate interaction effects and the craft of good UX

---

## Causality is a perception, and perception has a deadline

When you press a button and nothing changes, something specific happens in your mind: you stop believing you caused anything. The psychologist Albert Michotte demonstrated this in the 1940s with his studies of perceived causality. Show a person one ball moving, pausing, then striking a second ball that flies away, and they *see* the first ball launch the second. Stretch the pause past a fraction of a second and the perception collapses. The second ball appears to move on its own. The causal bond — which was never in the animation, only in the observer — dissolves.

Human-computer interaction runs on the same mechanism. A user does not read your documentation or your intent. They read your responses. When they click and the interface acknowledges the click within roughly a hundred milliseconds, the action and the reaction fuse into a single perceived event: *I did that.* When the acknowledgment arrives late, or not at all, the bond breaks. The interface changes, or fails to change, and the user cannot tell whether their action had anything to do with it.

This is why immediate interaction effects — the small, instant responses to hover, press, focus, and selection — are not decoration. They are the causal connective tissue of an interface. Everything else a designer does is built on top of whether the user's basic sense of agency survives contact with the machine.

The classic response-time literature frames the problem in three tiers. Below about 100 milliseconds, a response feels simultaneous with the action — this is the budget for acknowledgment. Below about 400 milliseconds — the Doherty threshold, named for IBM's 1982 finding on transaction systems — the user stays in a productive loop, thinking about the task rather than the tool. Around one second, the flow of thought is interrupted; the mind starts paging in doubts about whether the system noticed. Past ten seconds, attention is gone entirely.

Most of that literature concerns *task* latency: page loads, saves, searches. But the felt quality of an interface is governed less by how fast it completes tasks than by how fast it *acknowledges* actions. An application can complete every request in 200 milliseconds and still feel dead if hover states lag, buttons don't visibly press, or focus arrives after the user's eyes have already moved on. Conversely, an application with genuinely slow data operations can feel expert and alive if every touch is confirmed the instant it happens. The completion can take a second; the acknowledgment cannot take a tenth of one.

## Acknowledgment versus commitment

*Summary.* Interface responses divide into two kinds, and confusing them is the source of most bad interaction timing. An **acknowledgment** — a highlight, a pressed state, a hover cue — says *I heard you*; it is cheap, reversible, and consequence-free, so it must be immediate, inside the hundred-millisecond causal budget. A **commitment** — opening a tooltip, expanding a panel, firing an action — says *I will now change something*; it carries costs in visual noise, layout shift, and captured attention, and should wait for demonstrated intent: pointer rest, deliberate hover, or keyboard focus.

The mature pattern is therefore two-tier: instant to acknowledge, patient to commit. The instant the pointer touches a target, the target confirms *you found me*; the larger change waits for the pointer to come to rest. Interfaces that run one timer for both jobs fail in both directions — committing everything instantly feels skittish, delaying everything equally feels dead — which is why the failure modes below are worth naming separately.

## The failure modes, named

**Dead interfaces** offer no immediate effect at all. Every action is a message sent into silence. The user re-clicks, because a second click is the cheapest available test of whether the first one registered. They develop habits of over-clicking and double-checking that persist across the rest of their computing life. A dead interface charges each missing acknowledgment in doubt and repeated effort.

**Laggy interfaces** deliver their effects late. In one way this is worse than dead, because it doesn't just fail to confirm causality — it actively breaks it. The user sees a change but cannot connect it to their action; the interface behaves like a haunted house where things happen for reasons of their own. Latency after the first 150 milliseconds doesn't read as "slow," it reads as "random."

**Jittery interfaces** are inconsistent — sometimes instant, sometimes delayed. This is the failure mode people underestimate. Consistency matters more than raw speed. A steady 150-millisecond acknowledgment feels better than one that alternates between 20 and 120. The motor system adapts to rhythm; it cannot adapt to surprise. Users time their actions to the system's tempo, and an interface whose tempo drifts keeps them permanently off-balance.

**Skittish interfaces** commit everything instantly. This is the failure the doctrine of "immediate effects" gets blamed for, usually unfairly. The remedy for skittishness is never to delay the acknowledgment — the pressed state, the highlight, the hover cue should still arrive within a frame. The remedy is to gate the *commitment* behind intent. Blaming immediate effects for skittish interfaces is like blaming eye contact for staring; the problem is not the speed of the response but its magnitude.

## The physics of the immediate

Making an effect immediate is an engineering discipline, not a styling preference. The rules are stable across platforms:

**Acknowledgments belong to CSS, not JavaScript.** A `:hover` rule costs one style recalculation in the browser's compositor pipeline. Routing the same feedback through a JavaScript handler costs an event dispatch, a state update, a re-render, and a commit before the pixel ever changes — a hundred-millisecond budget spent on ceremony before the effect begins. State-driven effects are for things that must coordinate across components (a rail expanding, a mode engaging); they are wasted on local confirmation.

**No acknowledgment may depend on the network.** The highlight on a save button must not wait for the server. Feedback is a promise that interaction happened, not a report that it succeeded. Success and failure states arrive on their own schedule; the acknowledgment arrives on the frame.

**Prefer paint-only and compositor properties.** Color changes, shadow changes, and border changes cost a paint; `transform` and `opacity` cost less still. Animating layout properties — width, height, top — forces the engine to reflow the page on every frame, which on a constrained CPU turns a delightful acknowledgment into a stutter. Where a size change is the desired effect, keep the animated element small and isolated so the reflow it causes is contained.

**Feedback is faster than entrance.** An acknowledgment animation should complete in roughly 80 to 150 milliseconds — fast enough to fuse with the action. An entrance or transition — a panel sliding in, a menu unfurling — can take 200 to 250 milliseconds, because it *is* the commitment, and a touch more duration reads as intention rather than lag. The two durations doing different jobs is the timing corollary of the two-tier principle.

**The pressed state is sacred.** Of all acknowledgments, the one that must never be late is the press. A button that depresses within one frame of the click is trusted even when its results are slow. A button that only reacts after its operation completes has already taught the user that the machine does not listen.

## Rest as a signal of intent

If acknowledgments are immediate, what licenses a commitment to wait? The strongest natural signal available is pointer rest. Movement means transit; stillness means attention. A pointer that travels across the screen is on its way somewhere — committing to changes at every point along that route produces exactly the strobe of unwanted effects that skittish interfaces suffer. A pointer that comes to rest has made a small declaration: *I am looking at this.*

Rest-gated commitment — a few hundred milliseconds of stillness before the tooltip appears or the panel opens — filters transit while honoring inspection. Two details make it work well. First, the clock must be generous with tremor: tiny sub-pixel jitter should not reset the timer, or an unsteady hand reads to the system as perpetual refusal. A threshold of roughly a pixel and a half per event absorbs human hand physiology without letting real movement pass. Second, once the commitment has fired, subsequent interactions should be immediate — a user who has demonstrated intent and moves deliberately between adjacent targets should feel the system responding at acknowledgment speed, not re-proving intent at every step. Rest gates the *first* commitment; demonstrated engagement carries thereafter.

The same logic extends to the keyboard. Focus is intent in its purest form — a keyboard user cannot reach a control by accident. Focus-triggered commitments should therefore skip the rest gate entirely, and focus acknowledgments (the visible focus ring, which must never be removed without replacement) share the full immediacy budget of every other acknowledgment.

## Responsiveness as respect

The deeper case for immediate effects is not cognitive but social. An interface is a conversation. The user speaks by acting; the system answers by responding. A system that acknowledges every touch within the perceptual instant behaves like a good listener — it signals attention before it has anything to say. A system that responds only after processing, or not at all, behaves like a bureaucrat who waits until the whole matter is settled before confirming the letter was received.

Users cannot help reading interfaces this way. The perception of causality, the annoyance at latency, the unease with flicker — these are not learned conventions that a power user can unlearn. They are the operating characteristics of human attention, older than computing by an evolutionary margin. Good UX is largely the discipline of meeting those characteristics where they already are.

So spend the first hundred milliseconds on acknowledgment, always, unconditionally, for every interactive element — the highlight, the press, the ring, the ripple of a dash growing two pixels. It is the cheapest trust you will ever buy. Then spend the next three hundred on certainty rather than spectacle: let rest and focus and deliberate movement gate the commitments, so the interface reserves its louder changes for moments of actual attention. An interface that does both feels alive and composed at once — instantly attentive, never jumpy; calm, never dead.

That combination — *instant to acknowledge, patient to commit* — is not a compromise between responsiveness and restraint. It is what each of them properly means.

---

*Reference notes: Michotte, *The Perception of Causality* (1946). Miller, "Response Time in Man-Computer Conversational Transactions" (1968). Doherty & Thadani, IBM study of transaction response time (1982), source of the 400 ms "Doherty threshold." Nielsen, *Usability Engineering* (1993), response time limits of 0.1 / 1 / 10 seconds.*
