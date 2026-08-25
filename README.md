# Gmail ↔ monday bridge

Two independent Apps Script systems connecting Gmail and monday.com for G247.
Either can be switched off without affecting the other.

- **`intake/`** — Gmail → monday. Runs in each PM's own mailbox. Label an email
  with a board's name and a project appears on that board; replies append to it.
- **`relay/`** — monday → Gmail. Runs once centrally as `projects@group247ww.com`.
  Puts monday's automation emails inside the Gmail thread they belong to.
- **`deployed/`** — the exact three files pasted into the Apps Script editors.
- **`docs/`** — restore point, monday-side changes, PM setup email, feature list.

Both subfolders carry their own commit history, grafted in with `git subtree`.

## Deployed artefacts

| File | Apps Script project |
|---|---|
| `deployed/Code.gs` | Gmail-Monday Bridge |
| `deployed/Relay-INTERNAL.gs` | monday relay INTERNAL (`ROUTE = 'internal'`) |
| `deployed/Relay-CLIENT.gs` | monday relay CLIENT (`ROUTE = 'client'`) |

`Relay-INTERNAL.gs` and `Relay-CLIENT.gs` are identical except line 46.

## Tests

```
cd intake && npm test     # 72 assertions
cd relay  && node test/run_relay.js   # 80 assertions
```

They run against `Code.gs` and `Relay.gs` directly — the same files that are
pasted into the editor, not a derived build.

## The one discipline that matters

When you paste a change into the Apps Script editor, commit the same change
here. A repo that drifts from what is actually running is worse than no repo,
because it invites someone to "restore" a version that was never live.

Start from `docs/RESTORE-POINT-2026-08-25.md` if something breaks.
