# Putting this under your own version control

I can't push to your GitHub — that needs your credentials, and I won't take a
token in chat. What's attached instead is the complete repository, history and
all, in a form you can push yourself in about two minutes.

Two bundles: `g247-intake.bundle` (8 commits, the Gmail→monday intake) and
`g247-relay.bundle` (10 commits, both relay deployments). A git bundle is a
whole repo in one file — every commit, message and tag, not just a snapshot.

## To push them somewhere of yours

Create two empty repos (GitHub, GitLab, wherever), then:

```bash
git clone g247-intake.bundle g247-intake
cd g247-intake
git remote set-url origin https://github.com/YOURORG/g247-intake.git
git push -u origin --all && git push --tags
```

Same for the relay bundle. The tag `restore-2026-08-25` comes across with it,
so today's verified state is a named point you can always return to.

## What's in the history

Every commit message explains why the change was made, not just what changed —
the Message-ID case bug, why 'sending' is never retried, why the participants
column mirrors the live writer rather than taking a union. That reasoning is
the part worth keeping; it's what stops the next person undoing a fix because
it looks redundant.

## After that

Once the repos exist, the Apps Script files stay the deployed artefact and git
is the record. The one discipline worth keeping: when you paste a change into
the Apps Script editor, commit the same change. A repo that silently drifts
from what's running is worse than no repo, because it invites someone to
"restore" a version that was never live.

`clasp` (Google's Apps Script CLI) can push straight from a repo to the editor
and would remove that drift entirely. Worth doing if this keeps growing.
