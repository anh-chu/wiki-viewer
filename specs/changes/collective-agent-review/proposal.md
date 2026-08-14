# Proposal: collective agent review (instruct → send batch → review batch)

## Problem

Both agent surfaces share the same disease: **scattered, fire-and-forget, one-at-a-time
agent calls**, and the way "Comment" and "Ask agent" coexist is confusing.

- **Markdown "Ask agent"** (`ask-agent-popover.tsx`): select a block, type an instruction,
  hit Send, popover auto-closes in ~900ms. The result later materializes as a `<proof-span>`
  with no visible tie back to what you asked. Only one request may be outstanding per session.
  No way to annotate several blocks and dispatch them together.
- **Web "Tweak"** (`web-tweak-overlay.tsx`): each element tweak is its own immediate request.
  Same serialization and scatter, and the agent never sees the whole page at once, so
  multi-element changes drift out of sync.
- **Comment vs Ask agent is muddled.** A comment is a passive note to humans; Ask agent is an
  invisible fire-and-forget command. They look similar but behave completely differently, and
  nothing tells the user which one will change their file.

## The model (in UX terms)

**Two things you can pin to a target (a Markdown block or an HTML element):**

- **Comment** — a note to humans. It sits there. It never changes the file.
- **Instruction** — a work order for the agent. Something you intend to get done.

They share the same pin gesture and anchoring, but read as clearly different objects
(distinct icon + color). A user must never wonder "will this one change my file?"

**No audience toggle.** We do not put a "for humans / for agent" switch on one note. A toggle
turns every comment into "might this secretly be a command?" and invites accidental
execution. Instead there are two things you deliberately create.

**Explicit escalation.** A comment has one action, **"Turn into an instruction"** — one
direction, deliberate, with a backlink to the original comment. The comment is never silently
reinterpreted.

**Collect, then send once.** You leave instructions across the document; nothing fires. When
ready, one file-level button:

> **3 instructions ready · Send to agent**

Before sending, a dialog enumerates exactly which instructions on which blocks are going. You
confirm. The agent processes them together with whole-file context and returns **one coherent
change set tied to that send** (a "run"), so each returned change is visibly correlated to the
instruction it answers.

**Review as a batch.** Accept the whole run or discard it (all-or-nothing in v1). New
instructions start the next run.

**Retire the verb "Ask agent."** "Ask" implies an immediate conversational reply; this is a
queued work order reviewed later. The action is **Instruct** / **Send to agent** (mirrors
Cursor's Ask-vs-Agent split).

## Desired outcome

One rhythm on both surfaces: **pin your intent → send when ready → review as a batch.**

The only thing that differs between surfaces is how a result *looks while you review it*
(inline `<proof-span>` suggestion in Markdown vs a staged preview on the HTML page). That is
the medium, not the workflow.

## Scope (this change — step 1)

- **Two annotation kinds** on the shared anchoring machinery: `comment` (human) and
  `instruction` (agent work order). Instruction is a first-class kind, not a flag on a
  comment.
- **Comment → instruction escalation** as an explicit one-way action with a backlink.
- **A per-file instruction queue** with an enumerated **"Send N to agent"** dispatch. Nothing
  dispatches on creation.
- **One run per send**: the batch of instructions goes as a single agent dispatch carrying
  whole-file context; returned changes correlate to that run and to each instruction.
- **Batch review, all-or-nothing** for v1: Accept applies the whole run, Discard drops it.
  - Markdown: changes land as `<proof-span>`s (existing tier-2 path), reviewed inline, tagged
    with the run id.
  - Web: agent returns a staged preview set bound to one previewId, reviewed in the overlay.
- **Rename the user-facing verb** from "Ask agent"/"Tweak" to Instruct / Send to agent, with
  matching review vocabulary across both surfaces.

## Non-goals (this change)

- **Generate variants** (N alternatives for one target, switch-and-accept). High value,
  documented as **step 2**, built after this lands. Out of scope here.
- **Per-item / partial batch accept.** v1 is all-or-nothing. Per-item accept reintroduces
  multi-file atomicity / partial-commit rollback that were deliberately deferred.
- **Merging the two write engines.** Markdown keeps write-first-then-review (tier-2
  proof-span); web keeps write-on-accept (tier-1 candidate patch). This change unifies the
  *surface language and workflow*, not the engines. Line reviewers must enforce that no code
  path writes disk/provenance outside the two canonical commit paths.
- Multi-file candidate writes for web (still single-file per v1 web-tweak constraint).
- Real LLM handler wiring (separate track); the passthrough/dev runner remains the reference.
- Comment *replies/resolve* threading changes beyond what already exists.

## Risks

- **Annotation chrome.** Two similar pin types can clutter the document. Mitigate with one
  unified annotation presentation, restrained visual distinction, and filters, not two
  separate-looking subsystems.
- **Instruction-as-comment by habit.** Users type a work order into a comment. Mitigate with
  the explicit "Turn into an instruction" action and clear iconography.
- **Scope creep toward a unified Accept abstraction.** Rejected earlier. Keep two review
  mechanisms; unify only wording/affordances.
- **Correlation UX.** Users must see which returned change answers which instruction. Needs a
  run id threaded from send → each resulting proof-span / preview item.
- **Outstanding-request invariant.** Today one request is outstanding per session. Collective
  send is still one dispatch, so the invariant holds; the request now carries N instruction
  items instead of one.

## Acceptance criteria

1. A user can create a **comment** (human, never mutates the file) and an **instruction**
   (agent work order) on a Markdown block, visually distinct.
2. A user can create instructions on 2+ blocks with **no agent request firing**, then trigger
   a single file-level **"Send N to agent"** that dispatches them in one run.
3. The **send dialog enumerates** exactly which instructions/targets are going.
4. A **comment can be escalated** to an instruction via an explicit one-way action; the
   original comment is not silently changed.
5. The same collect → send → batch-review rhythm works in **web tweak** (instructions on
   elements, one Send, one preview run).
6. The agent receives whole-file context plus the instruction set in one dispatch.
7. The batched response is reviewable as a set; **Accept applies the whole run, Discard drops
   it** (all-or-nothing), with no partial writes on failure.
8. Each returned change is **visibly correlated** to the instruction it answers (run id +
   per-item linkage).
9. **No new write path**: Markdown via tier-2 `applyOps`; web via existing candidate-patch
   accept. Verified by test + review.
10. The user-facing verb is **Instruct / Send to agent** (no "Ask agent"), with matching
    review controls/wording on both surfaces.
11. Test floor holds; new tests cover: two kinds, escalation, collective dispatch, batch
    review, all-or-nothing failure.

## Sequencing

1. **This change** — two kinds (comment/instruction) + escalation + per-file instruction
   queue + single Send + all-or-nothing batch review, on both surfaces, sharing vocabulary.
   Also the moment the weak Markdown "Ask agent" fire-and-forget UX is replaced by the
   collect/send/review loop.
2. **Step 2 (separate proposal): generate variants** — single target, N staged candidates,
   in-frame/inline switcher, Accept the selected one. The impeccable-native differentiator.
