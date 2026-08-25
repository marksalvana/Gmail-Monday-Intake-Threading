# monday changes — the client automation

Applies to the **Send out for Approval** automation on iNova AU NEW
(C. Approval Status → Send out for Approval; id 7920355359).
**One automation, not two.**

Corrected 24 Aug from the monday API. The board has nine automations with an
email action, and **Send out for Approval** is the ONLY one that addresses anyone through the
Group Email column (`text_mm3wq0mc`) — every other one sends to `{{item.p_email}}`,
the item's own monday address, which is internal-route traffic the INTERNAL
relay already handles.

**The automation previously named as the second one (7921677764) has no email
action at all.** It sets dates, moves groups and clears
columns. It was named in the original spec and in the first version of this
checklist; that was wrong, and editing it would have done nothing useful.

### How to find it

monday does not show these numeric ids anywhere in the board UI. You find an
automation by its trigger sentence. All nine email automations sit on one of two
status columns:

| Trigger sentence to look for | Emails | id |
|---|---|---|
| C. Approval Status -> **Send out for Approval** | **the client, via Group Email** | 7920355359 |
| C. Approval Status -> **Approved** | p_email (internal) | 7920355429 |
| C. Approval Status -> **Rejected** | p_email (internal) | 7921636586 |
| C. Approval Status -> **Approved with changes** | p_email (internal) | 7921636602 |
| C. OH - Status -> **Send out for info** | p_email (internal) | 7920210482 |
| C. OH - Status -> **Feedback Provided - pls proceed** | p_email (internal) | 7921677772 |
| C. OH - Status -> **Cancel project** | p_email (internal) | 7920261851, 7921686826 |
| C. Change Request | no email action | 7922030030 |

**Send out for Approval is the only one a client ever receives.** Everything
else goes to the item's own monday address and is handled by the INTERNAL relay.

Do **nothing** here until you have watched CLIENT run in `self` mode and read a
relayed copy. These edits are what make the relay the client's only sender.

---

## 0. PREREQUISITE — resolve the attachment first

Verified from the API on 24 Aug: this automation's Send-email block has

```
to          <- item.text_mm3wq0mc   (Group Email)
attachments <- item.file_mm3prda0   (C. Approval Files)
```

**C. Approval Files is empty on all 60 P2612xx items.** The attachment field is
unmarked as optional in the monday UI but the runtime rejects the send when the
bound column is empty (`'attachments.$0.files' => 'files' is required`) — the
cause of ~25 failures between 6 July and 20 August.

Today that produces a visible Fail in monday's run history. **After step 1 it
produces nothing at all**: the client is no longer on the To line, so monday
never sends, the relay never sees a message, and `relayHealth()` cannot detect
it — that check looks for automations that WERE sent with no relay row.

Fix it first: either unbind the attachment, or use the two-variant pattern in
`two-variant-attachment.md`. Note that step 4's fallback inherits the same
dependency — a fallback that also fails is not a fallback.

---

## 1. Change the To field

From:

```
{{item.text_mm3wq0mc}}
```

To:

```
{{item.p_email}}; monday-client-relay@group247ww.com
```

The client is deliberately no longer addressed here. `monday-client-relay@` must
exist and accept mail — a Google Group with no members, or a discarding alias.
Nothing ever reads it; it exists so the relay can tell a client automation from
an internal one without parsing subject text.

## 2. Add this line at the very end of the message body

```
X-G247-Recipients: {{item.email_mm3wcj3h}}
```

`email_mm3wcj3h` is **C. Email** — the client contact, set automatically to
whoever emailed the labelled project. Verified 24 Aug: populated on 39 of 40
sampled items.

Use C. Email because it holds an **address**. 📒C. Contact (`connect_boards5`)
is a link to a contact item, not something an email field can resolve — it is
correctly populated (Victorine Mary, Jamie Lee, Emma Keogh, Lydia Melek…) and
First Name mirrors through it correctly, but it is not an address.

(An earlier version of this doc claimed C. Contact was empty. That was a query
error on our side: monday returns `text: null` for board_relation and mirror
columns by design — you have to read `display_value`. Both columns are fine.)

This is how the relay learns who the client is. monday resolves it off the item
at the moment it sends, so it is always current, and the relay strips the line
before the copy goes to the client — they never see it.

If C. Email is empty the relay still sends — to the PM and the item — and
records `clients=0`. An update is never withheld for want of a client contact.

Put it on its own line, last. If your editor forces styling, small grey text is
fine; the relay flattens the markup.

## 3. Leave this automation UNGATED

Corrected 24 Aug. monday's condition list offers **"If column is empty"** and
has no "is not empty", so the guard cannot be written the way this doc
originally asked. Do not add a condition here.

(If **Smart condition** — the first entry in that list — accepts
"🚫 Project Email is not empty" in plain language, use it and skip the wasted
send described below. Otherwise leave it ungated.)

## 4. Add the fallback automation, gated on EMPTY

> When **C. Approval Status** changes to **Send out for Approval**,
> **and only if 🚫 Project Email IS empty**, send the email to
> `{{item.text_mm3wq0mc}}` (Group Email) — and notify the G247 PM.

The two cover each other without ever needing a "not empty":

| 🚫 Project Email | Main automation | Fallback | Client gets |
|---|---|---|---|
| populated | sends to pulse + marker; relay threads it | condition false, silent | one threaded email |
| empty | To resolves to the marker alone — a discard address, nobody receives it; relay skips as `no-monday-item-address` | fires: Group Email + PM notified | one unthreaded email |

No duplicates in either case, and nothing is silently dropped.

The cost is one wasted send to the discard address on broken items. Harmless,
but watch run history: if an empty `p_email` produces a malformed recipient
rather than just the marker, it will show as an error there.

## 5. Check the Gmail connection after saving

All nine email automations on this board share ONE Gmail credential — id
`1017752`, `projects@group247ww.com`.

It silently disconnected on 23 Aug at 15:22 UTC and every monday email on the
board was dead for about 24 hours. The only symptom was `recipe_config_missing`
in run history and a banner on an automation nobody had open.

Re-saving a recipe is where connection state appears to get touched, so after
these edits confirm the connection is still attached — and not only on the
automation you edited.

If it drops again shortly after re-authorising Gmail scopes for
`projects@group247ww.com` in Apps Script, that correlation is your answer and
the two systems are competing for the same account's consent.

---

## Verifying it worked

Trigger one approval on a test item and read the CLIENT run report — **and
monday's own run history**. The relay report cannot see an automation that
never sent; only monday records that.

| What you see | What it means |
|---|---|
| `relayed: 1`, detail `body-line` | working as designed |
| detail `ledger-participants` | the body line is missing or empty — check step 2 |
| `routing-line-has-no-client` | the line resolved to G247 addresses only — Group Email has no client on that item |
| `no-client-on-thread` | fell back to the ledger and that thread has no client either |
| `other-route:internal` | the marker is missing from the To — check step 1 |
| `no-monday-item-address` | `p_email` was empty — step 3 should have prevented the send |
| *nothing at all in the relay report* | monday never sent. Check monday run history — most likely the attachment (step 0) or the Gmail connection (step 5) |

The first two rows are the ones to watch. `ledger-participants` means the relay
is running on the fallback, and the audit says the fallback reaches no real
client on any current project — so treat it as a failure, not a degraded pass.
