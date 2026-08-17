# Issue tracker

Issues for this repo live in **Linear**, workspace `silverycaster`, project
**wiki-viewer** (`wiki-viewer-858e6b16ea00`), team **Personal Ops (OPS)**.

The engineering skills (`to-spec`, `to-tickets`, `implement`, and any triage
flow) read from and write to Linear through the `linear` CLI (v2.5.0+, authed as
`chuducanh.atred@gmail.com`).

## CLI cheatsheet

Always target the project and team explicitly.

```bash
# Create an issue from a markdown file (preferred for spec/ticket bodies)
linear issue create \
  --team OPS \
  --project wiki-viewer-858e6b16ea00 \
  --title "<title>" \
  --description-file <path.md> \
  --label ready-for-agent

# List issues in the project
linear issue query --project wiki-viewer-858e6b16ea00

# View / update an issue
linear issue view <issueId>
linear issue update <issueId> --state "<state>" --label <label>

# Dependencies between tickets (to-tickets blocking edges)
linear issue relation --help
```

Notes:

- Pass spec/ticket bodies via `--description-file`, not `-d`, so multi-line
  markdown survives intact.
- `--project` accepts the slug ID `wiki-viewer-858e6b16ea00`, a UUID, or the
  project name.
- Team key is `OPS`.

## Label vocabulary

The `triage` skill is **not** installed in this environment, so the full
five-role triage vocabulary does not apply. Only the label the engineering
skills actually emit is provisioned:

- `ready-for-agent` (`OPS`) — spec/ticket is triaged and ready for an
  implementing agent to pick up. `to-spec` applies this on publish.

Add further labels only if a skill that needs them gets installed later.

## PRs as a request surface

Off. External pull requests are not part of the triage/request queue for this
repo.
