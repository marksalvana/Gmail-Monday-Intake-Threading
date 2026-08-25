**Subject:** 10 minutes — Gmail → monday setup

Hi [Name],

Your board: **[BOARD NAME]**

Label an email with your board's name → a project appears on that board within a minute. Replies in that thread attach to the same project.

**Setup (once)**

1. **Create the Gmail label** — copy/paste your board name from monday, don't type it.

2. **Open the script** → https://script.google.com/d/1SLQ688qeW93Vp5SWBIaIJD2mBNJJvOWzHPKK01-XTtJQtwDmHhZcGkE3/edit
   Run **preflight** → **Advanced** → **Go to … (unsafe)** → **Allow**.
   Last line of the output must show your label → your board.

3. Run **runLive** — marks "start from here".

4. Run **backfillParticipants** — `notMine` in the output is normal.

5. Run **installLiveTrigger** — done, it runs by itself from now on.

**Good to know**

- monday's project emails now appear inside the Gmail thread they belong to, from "G247 Projects".
- Reply to the client's message as normal. Don't reply to the "G247 Projects" copy — it's a mirror, not a way in.

**Don't**

- Copy the script · Run `runShadow` · Edit the tracking spreadsheet · Delete a bridge-created project without telling me

Nothing appearing? Run **preflight** — it's almost always the label.

Thanks,
Mark
