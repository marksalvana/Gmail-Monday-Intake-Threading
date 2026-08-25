# Gmail ↔ monday bridge — what it does

Two independent systems. Either can be switched off without affecting the other.

---

## 1. Gmail → monday (intake)

Runs in each PM's own mailbox, every minute.

| Feature | Status |
|---|---|
| Label an email with a board's name → project created on that board | live |
| Board matched on **exact** name; a near-miss never creates a project | live |
| Email body becomes the first update, full HTML preserved | live |
| Attachments carried onto the item | live |
| Replies in the thread append to the same project, not a new one | live |
| Same email never creates twice (Message-ID dedup) | live |
| Sender's address written to **C. Email**, contact linked to **C. Contact** | live |
| Item dated from the original email, not from when it was created | live |
| Records who is on each thread, refreshed on every reply | live |
| Each PM on their own board — no shared configuration | live |
| Forwarding an email into a tracked thread appends it too | live |

**Self-checks and repairs:** `preflight` (label ↔ board match), `verifyInstall`, `participantsAudit`, `backfillParticipants`, `repairLedgerMessageIds`.

---

## 2. monday → Gmail (relay)

Runs once, centrally, as `projects@group247ww.com`. Two deployments, separately switchable.

### Internal route — live

| Feature | Status |
|---|---|
| monday's internal automation emails (approved, rejected, cancelled, feedback) copied into the project's Gmail thread | live |
| Lands **inside** the existing conversation, not as a new one | live |
| Uses the thread's own subject — monday's subject preserved in the body | live |
| Relayed copies never re-ingested by the intake | live |
| Never sends the same automation email twice | live |
| Kill switch, hourly rate cap, refuses to run as the wrong mailbox | live |

### Client route — built and tested

| Feature | Status |
|---|---|
| The client's approval email delivered **by the relay, threaded**, instead of by monday as a new conversation | tested |
| Client address read from **C. Email** at send time — never stale | tested |
| Routing line stripped before sending; the client never sees it | tested |
| **Reply-To set to the PM** — a client reply lands in the PM's mailbox and is added to the monday item | tested |
| Projects with no client contact still reach the PM and the item | tested |
| One retry on failure, then alerts — a client is never silently missed | built |
| Its own rate budget; hitting the cap raises an alert rather than waiting | built |
| `self` mode — real copies to Mark only, for testing without touching a client | live |
| `relayHealth` — daily check for client mail that was sent but never relayed | built |

---

## What it does not do

- Projects that predate the bridge have no Gmail thread and cannot be threaded.
- Internal-only forwards inside a tracked thread are still appended to the client's item.
- monday's own failures (Gmail connection dropped, automation misconfigured) surface only in monday's run history, not in any alert we control.
