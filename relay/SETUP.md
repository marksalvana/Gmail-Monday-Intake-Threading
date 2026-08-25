# monday automation → Gmail thread relay — setup

Two Apps Script projects, one file, differing in a single line. Both run as
**projects@group247ww.com**.

## Before anything: verify the assumption this rests on

The whole design assumes monday's automation emails leave a copy in
`projects@group247ww.com`'s **Sent** items, because they are sent through a Gmail
connection on that account.

Check it in thirty seconds: open that mailbox and search Sent for `pulse-`.
You should see the approval and missing-information emails, each addressed to a
`pulse-<number>@g247ww.us.monday.com` address.

**If nothing comes back, stop** — monday is sending through its own servers
rather than the Gmail connection, and this approach does not apply. Tell me and
I will rework it.

## What each script covers

**Relay-INTERNAL** handles the seven automations addressed only to the item's own
monday address: Approved, Rejected, Approved with changes, Feedback Provided,
and the two Cancel project ones.

**Relay-CLIENT** handles the two that also reach a real client through Group
Email: Send out for Approval, and Sending now!.

Two automations cannot be handled by either, and this is a limit of the
mechanism rather than a bug: **Priority Change Request** (7922030030) goes to a
literal address and **the due-date reminder** (legacy 587642823) goes to the PM
and task owner. Neither carries a `pulse-<itemid>` address, so there is no item
id to match on and no way to know which thread they belong to.

## Who owns it, and who runs it — not the same thing

The project can live in **your** Drive. A time-based trigger runs as whoever
created the trigger, not as the file's owner, so ownership and execution are
separate questions.

What matters is that somebody **signs in as projects@group247ww.com** to
authorise the script and install the trigger. Gmail delegate access — the kind
where you read that mailbox from your own Gmail — is not enough: a script
authorised that way runs as *you*, reads *your* mailbox, finds no automation
copies, and reports a clean run having done nothing.

Every pass now checks this and refuses if it is running as the wrong person, so
the failure is loud rather than silent. But it is worth settling before you
start: can you actually sign in as projects@group247ww.com, or do you only have
delegated access to it?

So the sequence is: you create and share the project, then sign in as
projects@ (or have whoever holds it sign in), run `relayPreflight` there to
authorise, and install the trigger from that session.

## Setup, per script

1. Create a new Apps Script project — under your own account is fine. Name it
   clearly: "monday relay INTERNAL" and "monday relay CLIENT". Share each with
   projects@group247ww.com as Editor.
2. Paste the matching file into it: `Relay-INTERNAL.gs` or `Relay-CLIENT.gs`.
   They are identical except for line 46, `var ROUTE`.
3. **Add the Gmail API.** Click the **`<>` Editor** icon in the left rail — not
   Project Settings. The panel lists **Files**, **Libraries**, **Services**;
   hover over **Services** and click the **⊕** at its right. In the dialog,
   scroll to **Gmail API**, select it, leave the identifier as `Gmail`, and
   click **Add**.

   Google's dialog says "Gmail API", not "advanced service". The identifier
   matters: the code calls `Gmail.Users.Messages.get(...)`, so anything other
   than `Gmail` fails with "Gmail is not defined". Services are per-project, so
   do this on each relay project separately — sharing a project does not carry
   them over.
4. Create a **new, empty Google Sheet** for this script's own state — one per
   script, not shared. Paste its id into `STATE_SPREADSHEET_ID` near the top.
   Its own sheet matters: Apps Script's lock is scoped to a project, so separate
   projects appending to one spreadsheet will eventually overwrite each other.
5. Make sure projects@group247ww.com can **read** the intake's ledger
   spreadsheet. Read access is enough — this script never writes to it.
6. **Signed in as projects@group247ww.com**, run **`relayPreflight`** and accept
   the OAuth prompts. Every line must be
   clean. It also reports how many items are syncable at all.
7. Run **`relayDryRun`**. It sends nothing and logs what it would have relayed.
   Mode is off by default, so the first run returns immediately — that is
   correct.
8. Run **`relayOn`**, then **`relayRun`** once. It seeds its cursor and relays
   nothing. Also correct.
9. Change a project's status on monday to fire one automation, wait a moment,
   then run **`relayRun`**. Check the PM's Gmail: the message should appear
   **inside the project thread**, not as a new conversation.
10. Only then, still signed in as projects@, **`installRelayTrigger`** — every
    five minutes. Installing it from any other account makes it run as that
    account, and the identity guard will refuse every pass.

`relayOff` is the kill switch. `removeRelayTriggers` stops that script entirely
and touches nothing else.

## What it will not sync, by design

Only projects the Gmail bridge itself created have a Gmail thread in the ledger.
Any iNova project that predates the bridge has nowhere to put these emails, and
they are skipped and counted under `item-has-no-gmail-thread`. That count is the
honest measure of coverage — check it after a day.

## Two things to fix on the monday side

`7920261851` and `7921686826` both fire on **C. OH - Status → Cancel project**,
so that transition sends two emails today, and the relay will faithfully mirror
both.

Six templates open with `h {{...}},` — a typo for "Hi" — currently going out on
every Approved / Rejected / Approved-with-changes email.
