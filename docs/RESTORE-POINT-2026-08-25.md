# Restore point — 25 August 2026

The last state where everything was verified working. Client threading proven
end to end on "Project 9" (item 12881191202) via `self` mode; INTERNAL relay
live; intake live across five mailboxes.

---

## Files in this restore point

Saved alongside this doc in the Claude project. These are the exact contents to
paste back.

| File | Lines | md5 |
|---|---|---|
| `restore-2026-08-25-Code.gs` | 3847 | `74db06f5990a161ca72ec61b7c9c636e` |
| `restore-2026-08-25-Relay-CLIENT.gs` | 1208 | `4bde70560c0ad2f5390a76680f46a45c` |
| `restore-2026-08-25-Relay-INTERNAL.gs` | 1208 | `2fe75ccf6860b1bf3a9df54edac9a7ba` |

Tests at this point: intake **72 assertions**, relay **80 assertions**, all passing.

Git tag `restore-2026-08-25` — intake `cfab5fa`, relay `13e0b8e`. Note the
working container is temporary; the copies in the Claude project are the ones
that survive.

---

## Where each file goes

| Apps Script project | Paste | Check after pasting |
|---|---|---|
| **Gmail-Monday Bridge** | Code.gs | `verifyInstall` → all symbols present, no warnings |
| **monday relay INTERNAL** | Relay-INTERNAL.gs (`ROUTE = 'internal'`, line 46) | `relayPreflight` → all green |
| **monday relay CLIENT** | Relay-CLIENT.gs (`ROUTE = 'client'`, line 46) | `relayPreflight` → all green |

Replace the whole file each time. Do not merge by hand.

---

## Configuration that must survive a restore

These live outside the code. Restoring the files does **not** restore these.

| Setting | Value |
|---|---|
| Intake script id | `1SLQ688qeW93Vp5SWBIaIJD2mBNJJvOWzHPKK01-XTtJQtwDmHhZcGkE3` |
| Ledger spreadsheet | `1HEx6QQaTyOazuOEX0K0RdfxRzO843gouL00zHCIRldw` (sheet `ledger`) |
| INTERNAL state spreadsheet | `10KSgw9vgpzBsg69XZpdzhINDsM0TUvPVWYOyq2gWIJw` |
| CLIENT state spreadsheet | `1zCN0symOM6DrZTNl0VxZYkI9wvMSCg1rAFCjeBlWhdY` |
| Relay runs as | `projects@group247ww.com` |
| monday Gmail credential | id `1017752`, `projects@group247ww.com` — shared by all 9 email automations |
| Board | iNova AU NEW, `18401123784` |
| Route marker | `monday-client-relay@group247ww.com` |

**Fill these in before you need them:**

- INTERNAL relay mode at restore point: `on`
- CLIENT relay mode at restore point: `_____` (self / on)
- monday To field on Send out for Approval: `_____` (original / changed)
- Routing line in that automation's body: `_____` (absent / present)

---

## monday side — what to revert

Rollback here is instant and needs no code change.

**Send out for Approval** (C. Approval Status → Send out for Approval, id 7920355359):

- **To field**, original value: `{{item.text_mm3wq0mc}}`
- **To field**, changed value: `{{item.p_email}}; monday-client-relay@group247ww.com`
- **Body routing line** (added): `X-G247-Recipients: {{item.email_mm3wcj3h}}`

To roll back client threading: put the To field back to `{{item.text_mm3wq0mc}}`
and delete the routing line. monday resumes emailing clients directly, exactly
as before. **Do this first** — `relayOff()` alone stops the relay but does not
restore client delivery, so it would leave clients receiving nothing.

---

## Rollback order

1. **monday first** — revert the To field. Clients are receiving mail again.
2. `relayOff()` on CLIENT.
3. Re-paste the three files if the code is what broke.
4. `relayPreflight` on both relay projects; `verifyInstall` on the intake.
5. `relayOn()` on INTERNAL only. Leave CLIENT off until you know what broke.

If only the client route is misbehaving, step 1 plus step 2 is the whole
rollback — the intake and INTERNAL relay are untouched by it.

---

## Known open items at this restore point

- **662 of 680 board items have no Gmail thread.** After the To-field change,
  an approval on any of those sends the client nothing — the relay skips at
  `item-has-no-gmail-thread` before it ever reads C. Email. Unresolved; options
  were accept, send unthreaded, or stage the rollout.
- The attachment on Send out for Approval (`file_mm3prda0`, C. Approval Files)
  is empty on all sampled items, and the automation has been succeeding anyway.
  Treat as tolerated, not proven safe.
- `relayHealth` cannot detect a dropped monday Gmail connection — it looks for
  mail that was sent, and a dead connection sends nothing. monday's run history
  is the only place that surfaces.
- Internal forwards inside a tracked thread still append to the client's item.
