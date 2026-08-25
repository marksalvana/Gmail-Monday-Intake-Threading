# Keeping the attachment without the failure

The problem: seven of the nine email automations on iNova AU NEW list a Files
column as a **required** field. When that column is empty the whole Send-email
block fails — no email, to anyone. Proven on item 12875245428 (P261289 -
Project 8), where `p_email` and Group Email were both populated and
`file_mm3prw4r` (C. Approved Files) was `null`.

The pattern below keeps the attachment when there is one and still sends when
there isn't.

---

## Before you start — one thing to check

monday does not offer the same conditions for every column type. Open any of
these automations, click **Add condition**, and see whether **C. Approved
Files** appears with an **is empty / is not empty** option.

- **If it does** — use Plan A below.
- **If it doesn't** — file columns are not conditionable on your plan, so use
  Plan B.

Check this first. Everything else depends on the answer.

---

## Plan A — condition directly on the file column

Do this per status you care about. Start with **Send out for Approval** (the client-facing
one, attaches C. Approval Files), then **Approved with changes** (attaches
C. Approved Files).

**Variant 1 — the existing automation, now guarded**

Open it and add one condition. Change nothing else.

> When **C. Approval Status** changes to **Approved**, **and only if C. Approved
> Files is not empty**, notify …, and then send an Email to … *(attachment kept)*

**Variant 2 — the duplicate, without the attachment**

Use the automation's **⋯ → Duplicate**. Do not rebuild it by hand; the body has
six dynamic fields and retyping them is how they drift apart.

On the copy:

1. Flip the condition to **only if C. Approved Files IS empty**.
2. In the Send-email action, **remove the attachment field**.
3. Add one line to the body, above the sign-off:

   ```
   The approved file is on the project item — link above.
   ```

That last line matters more than it looks. Do not try to keep the two bodies
identical: they will drift within months and you will not notice. Make the
difference *deliberate and visible*, so anyone reading either email knows which
variant they got.

Turn both on.

---

## Plan B — a mirror column, if file columns cannot be conditioned

Add a **Status** column, `Has Approved File`, with labels `Yes` and `No`.

Keep it in sync with two small automations:

> When **C. Approved Files** changes, set **Has Approved File** to **Yes**
>
> When **C. Approved Files** becomes empty, set **Has Approved File** to **No**

Then build the two variants exactly as in Plan A, conditioning on
**Has Approved File is Yes** / **is No** instead of on the file column.

The cost is one more column and two more automations, and a lag: if someone
uploads a file and flips the status in the same breath, the mirror may still say
`No` and they will get the no-attachment version. Annoying, not harmful.

---

## The race, so it doesn't surprise you

Both variants fire on the same trigger and read the file column independently.
If a file is uploaded in the couple of seconds *between* those two reads, the
empty-variant can send before the file lands and the attachment-variant can send
after — **two emails to the same recipient**.

It needs an upload within seconds of the status flip, so it is rare, and it is
self-evident when it happens because someone receives a duplicate. Worth knowing
about; not worth engineering around.

If you would rather not carry that risk at all, drop the attachment from the one
automation and let the item link do the work. One automation, no duplication, no
race, no dependency on whether someone remembered to upload.

---

## Verifying

Take one test item and run it twice.

1. **C. Approved Files empty** → flip C. Approval Status to Approved.
   Expect: email arrives, no attachment, extra line present. Run history: Success.
2. **Attach a file** → flip the status away and back.
   Expect: email arrives with the attachment, no extra line. Run history: Success.

If either shows **Fail** with `recipe_config_missing`, the condition is on the
wrong variant — the guarded one is running when the column is empty.

---

## Do this before changing Send out for Approval's To field

Under today's setup an empty file column means monday fails and logs it, and you
can see it. After the checklist change removes the client from monday's
recipients, an empty file column means the client's approval request is never
sent by monday **and** never relayed — the relay only ever sees mail that
actually went out. `relayHealth()` will not catch it either: it looks for
automations that were sent with no relay row, and this one is never sent.

Fix the attachment dependency first. Then change the To field.
