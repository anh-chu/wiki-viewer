# Requirements: collective agent review

Each requirement is observable behavior. Scenarios use GIVEN / WHEN / THEN.

## R1 — Two annotation kinds on a Markdown block

A block-anchored annotation is either a **comment** (human) or an **instruction** (agent work
order). They are visually distinct and behave differently.

- GIVEN a selected Markdown block
- WHEN the user opens the annotation affordance
- THEN they can create a **Comment** (human discussion) or an **Instruction** (agent work
  order), each with distinct icon/label
- AND creating either one does **not** dispatch any agent request

## R2 — Comment never mutates the file

- GIVEN a comment exists on a block
- WHEN the user sends instructions to the agent (R5)
- THEN the comment is **not** included and never causes a file edit

## R3 — Explicit comment → instruction escalation

- GIVEN an existing comment
- WHEN the user chooses "Turn into an instruction"
- THEN a new instruction is created for the same block, carrying the comment's text, with a
  backlink to the original comment
- AND the original comment is left unchanged (not silently retyped or deleted)
- AND there is no persistent audience toggle that flips a note between kinds

## R4 — Instructions accumulate without firing

- GIVEN the user creates instructions on 2+ different blocks
- WHEN each instruction is created
- THEN no agent request is dispatched
- AND a per-file indicator shows the count, e.g. "3 instructions ready"

## R5 — Single enumerated batch send

- GIVEN 1+ unsent instructions exist for the current file
- WHEN the user clicks "Send N to agent"
- THEN a confirmation lists exactly which instructions (text + target block) will be sent
- AND on confirm, all listed instructions are dispatched as **one run** (single live request
  carrying N instruction items) with whole-file context
- AND while a run is outstanding, a second send is refused with a clear message (one
  outstanding run per session)

## R6 — Batch response correlates to instructions

- GIVEN a run was sent with N instructions
- WHEN the agent responds
- THEN the returned changes are associated with that run id
- AND each returned change is linked to the instruction it answers (so the UI can show
  "this change answers instruction X")

## R7 — All-or-nothing batch review (Markdown)

- GIVEN an agent run produced M activity/audit provenance changes for the current file
- WHEN the user Accepts the run
- THEN all M changes are accepted together
- WHEN the user Discards the run
- THEN all M changes are reverted together
- AND if applying any change fails, no partial state is committed (existing tier-2
  baseRevision / STALE_REVISION semantics still hold per change)

## R8 — Same rhythm on web tweak

- GIVEN a static-HTML page in Tweak mode
- WHEN the user pins instructions to 2+ elements
- THEN no request fires per element
- WHEN the user clicks "Send N to agent"
- THEN the instructions dispatch as one run
- AND the agent returns a staged preview set (write-on-accept, source clean) reviewed as a
  batch: Accept commits the run, Discard drops it

## R9 — Verb rename

- GIVEN either surface
- THEN the user-facing action is **Instruct** / **Send to agent** (no "Ask agent" wording)
- AND Markdown and web use matching review vocabulary (e.g. "Accept run" / "Discard run")

## R10 — No new write path

- THEN Markdown changes are written only through the existing tier-2 `applyOps`
- AND web changes are written only through the existing web-tweak candidate-patch accept
- AND no code path writes document bytes or provenance outside those two commit paths

## R11 — Backward compatibility

- GIVEN existing files with only legacy comments (no instructions)
- THEN they load and render unchanged
- AND the additive annotation-kind field is nullable/defaulted so old sidecars and old event
  consumers are unaffected
- AND the frozen async `recover` path is untouched

## R12 — Non-goals stay out

- THEN there is no variant generation (N alternatives per target) in this change
- AND there is no per-item partial accept of a run
- AND the two persistence engines are not merged
