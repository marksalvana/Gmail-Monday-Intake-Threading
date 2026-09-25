/**
 * G247 monday-automation -> Gmail thread RELAY
 * ============================================
 *
 * A SEPARATE, SELF-CONTAINED Apps Script project. It shares nothing with the
 * Gmail->monday intake except read access to that system's ledger sheet, so it
 * can be switched off, broken, or deleted without touching the bridge that four
 * PMs depend on.
 *
 * WHAT IT DOES
 * ------------
 * monday's automations send their stage emails through a Gmail connection on
 * projects@group247ww.com, so a copy already sits in that mailbox's Sent items.
 * Those emails are standalone — they have no References header, so they never
 * join the project's Gmail conversation, which is why monday and Gmail drift
 * apart.
 *
 * This script runs AS projects@group247ww.com, finds those sent copies, and
 * relays each one to the PM who owns the project's Gmail thread, stamped with
 * the thread's own Message-ID so Gmail files it into the conversation.
 *
 * WHY RELAY RATHER THAN INSERT
 * ----------------------------
 * Gmail's messages.insert only writes into the mailbox the script is
 * authenticated as. The thread lives in the PM's mailbox, not this one, and
 * reading another user's mailbox through the API needs domain-wide delegation
 * with a service account — the exact auth layer this project spent weeks
 * removing. Sending a copy achieves the same result with no privileged access.
 *
 * TWO DEPLOYMENTS, ONE FILE
 * -------------------------
 * Deploy this file twice, as two separate script projects, changing only ROUTE:
 *
 *   ROUTE = 'internal'  the seven automations addressed only to the item's own
 *                       monday address (Approved / Rejected / Cancel / etc.)
 *   ROUTE = 'client'    the two that also go to a real client via Group Email
 *                       (Send out for Approval, Sending now!)
 *
 * Each has its own trigger, its own kill switch and its own state, so either can
 * be turned off without affecting the other.
 */

// ============================================================ CONFIGURATION

/** 'internal' | 'client'. THE ONLY LINE THAT DIFFERS BETWEEN THE TWO COPIES. */
/** Which build is pasted in the editor. Printed by relayPreflight(). */
var BUILD = 'relay 2026-09-15e grey-heading+full-width+roots-remembered+client-1min+logo+black-bg+white-card+600px-column+boxed-heading+skips-recorded+state-trim+no-re-prefix+dates-ddd-DD-MMM';

var ROUTE = 'client';

/**
 * The mailbox this must run as.
 *
 * The project can be OWNED by anyone — a time-based trigger runs as whoever
 * created it, not as the file's owner. But Gmail calls here are all 'me', so if
 * a pass ever runs as the wrong person it reads the wrong mailbox: it would find
 * no automation copies, seed a cursor against the wrong history, and report a
 * clean run having done nothing. Silent success is this project's oldest bug.
 * So every pass checks who it is first and refuses if it is not this address.
 */
var EXPECTED_MAILBOX = 'projects@group247ww.com';

/** The intake's ledger. READ ONLY — this script never writes to it. */
var LEDGER_SPREADSHEET_ID = '1HEx6QQaTyOazuOEX0K0RdfxRzO843gouL00zHCIRldw';
var LEDGER_SHEET = 'ledger';

/**
 * This script's OWN spreadsheet, for its dedup rows and run log.
 *
 * Deliberately NOT the intake's. LockService.getScriptLock() is scoped to a
 * script project, so separate projects do not serialise against each other:
 * three projects appending to one sheet would eventually overwrite each other's
 * rows. Separate spreadsheets remove the problem rather than manage it.
 *
 * One per route, both listed here and chosen by ROUTE, so a fresh paste of this
 * file is immediately correct and there is no manual step to forget. Getting
 * these two crossed would make each deployment read the other's dedup rows and
 * relay everything twice, so the two ids never live in the same variable.
 */
var STATE_SPREADSHEET_IDS = {
  internal: '10KSgw9vgpzBsg69XZpdzhINDsM0TUvPVWYOyq2gWIJw',   // Relay-INTERNAL
  client:   '1zCN0symOM6DrZTNl0VxZYkI9wvMSCg1rAFCjeBlWhdY'    // Relay-CLIENT
};

var STATE_SPREADSHEET_ID = STATE_SPREADSHEET_IDS[ROUTE] || '';

/**
 * Logo shown above the card. MUST be a public https URL: Gmail and Outlook do
 * not render base64 data: images in mail. Empty string = no logo row.
 */
var LOGO_URL = 'https://group247ww.com/wp-content/uploads/2020/08/group247-logo-e1622294952207.png';
var LOGO_WIDTH = 220;   // native 286x87; never scale up

var STATE_SHEET = 'relayed';
/** Rows kept on the state sheet. ~50 sends a day makes this about three months. */
var STATE_MAX_ROWS = 5000;
var STATE_HEADERS = ['ts', 'route', 'sourceMessageId', 'itemId', 'toMailbox',
  'threadId', 'subject', 'relayedMessageId', 'result', 'detail'];

/**
 * Skip reasons that get a state row, result 'skipped:<reason>'.
 *
 * WHY. relayHealth() looks for a sent client automation with no state row and
 * calls it "NOT RELAYED AT ALL — the relay may not be running". Skips used to
 * write nothing, so every deliberate skip — a kick-off root, a project with no
 * thread, a message with no recipients — was reported as a dead relay. The 11
 * Sep alert listed ten of them, every one a message the relay had seen and
 * decided about. A decision that leaves no trace is indistinguishable from a
 * relay that never ran, and that was the check's whole purpose.
 *
 * Only decisions about a message ON THIS ROUTE are recorded, and only terminal
 * ones. 'other-route:*' and 'no-monday-item-address' are not this deployment's
 * business (the internal sheet would otherwise carry a row for every client
 * email). 'awaiting-intake-seed' is a hold, not a decision, and is re-seen
 * every pass. 'already-relayed', 'in-flight-outcome-unknown' and 'failed-*'
 * already have the row that caused them.
 */
var RECORDED_SKIPS = {
  'item-has-no-gmail-thread': true,
  'is-the-thread-root': true,
  'no-recipients-in-ledger': true,
  'ambiguous-multiple-items': true,
  'no-item-id': true,
  'retries-exhausted': true
};

/** off = nothing sent. on = relay. Unset means off; turning it on is deliberate. */
var PROP_RELAY_MODE = 'G247_RELAY_MODE';
var CURSOR_KEY = 'relayCursor';

/**
 * Addresses at these domains are US, not a client.
 *
 * The split between the two deployments is by DOMAIN, not by recipient count.
 * The first version asked "is the item address the ONLY recipient?" and was
 * wrong in practice: monday's config for the Approved / Rejected / Cancel
 * automations says they send to {{item.p_email}} alone, but the messages
 * actually go out to the pulse address AND the PM —
 *   To: pulse-12872173573@g247ww.us.monday.com, msalvana@group247ww.com
 * (read from the live Sent copy, 22 Aug). That made every internal approval
 * email look client-facing and the INTERNAL relay declined all of them.
 *
 * Domain is the question that actually matters anyway: has anything left G247?
 */
var INTERNAL_DOMAINS = ['group247ww.com'];

/**
 * THE ROUTE MARKER. A recipient, not a mailbox.
 *
 * Once the client-facing automations stop addressing the client directly, every
 * recipient left on them is either the item or a @group247ww.com address — so
 * the domain rule above would classify them as INTERNAL and the wrong
 * deployment would relay them. The marker is how a client-facing automation is
 * identified deterministically.
 *
 * Routing on subject text was considered and rejected: subjects are editable by
 * anyone with board access, so a wording change would silently reroute client
 * mail.
 *
 * It must exist as an address (a Google Group with no members, or an alias that
 * discards) so monday can send to it without bouncing. Nothing ever reads it.
 */
var CLIENT_ROUTE_MARKER = 'monday-client-relay@group247ww.com';

/**
 * THE ROUTING LINE. monday tells us who the client is, in its own message body.
 *
 * The relay cannot learn the client any other way. Once the automation stops
 * addressing them, their address is nowhere in the headers; the intake cannot
 * read it at item-creation time because monday's project-setup chain populates
 * those columns AFTER the item exists (which is why two of six items on 22
 * August had no p_email at all); and the Gmail thread does not carry them — the
 * 23 August audit found zero real client contacts across 18 projects.
 *
 * So the automation body carries a line the relay parses:
 *
 *     X-G247-Recipients: {{item.text_mm3wq0mc}}
 *
 * It is read from the item at the moment monday sends, so it cannot go stale,
 * and it needs no monday credential in this script. It MUST be stripped before
 * the relayed copy goes out — see stripRecipientsLine().
 */
var RECIPIENTS_LINE_TAG = 'X-G247-Recipients';

/**
 * Never a recipient of a relayed copy, whatever the ledger says.
 * Automated senders end up on threads and must not be mailed back.
 */
/**
 * OPT-IN HTML.
 *
 * monday's send-email action ships text/plain no matter what its "Message"
 * format dropdown says — verified 27 Aug on three consecutive sends with the
 * dropdown set to HTML: every one arrived with a text/plain part and no
 * text/html part, tags intact as literal characters. So a PM who types <b>Hi</b>
 * into the automation body gets <b>Hi</b> in front of the client.
 *
 * The relay cannot detect intent by sniffing for tags — a client quoting
 * "use <brackets>" would be silently reformatted — so the automation body opts
 * in explicitly, exactly like the routing line:
 *
 *     X-G247-HTML: 1
 *
 * With it, the body is rendered as authored HTML through a DEFAULT-DENY
 * whitelist (see renderAuthoredHtml). Without it, nothing changes: the body is
 * escaped into a <pre> as it has been all along. Absent or malformed means
 * plain — the safe direction, because escaping HTML that was meant as HTML
 * looks wrong, while NOT escaping text that was never HTML can execute.
 *
 * MUST be stripped before relaying — it is plumbing, like the routing line.
 */
var HTML_LINE_TAG = 'X-G247-HTML';

/**
 * THE ONLY THING THAT MAY ROOT A PROJECT'S THREAD.
 *
 * Rooting used to happen on any monday automation email for an item the ledger
 * did not know. That is too generous: a status change nobody thought about
 * would quietly start a client-facing conversation. Rooting is now deliberate —
 * a PM toggles a column, that fires the kick-off automation, and the kick-off
 * body carries:
 *
 *     X-G247-Root: 1
 *
 * The intake seeds only on that line. The relay reads it too, for one reason:
 * to know whether waiting is worth it. Without the line an unrooted item is
 * never going to be rooted, so holding the cursor for the grace window would be
 * waiting for something that is not coming.
 *
 * Plumbing, so stripped from any relayed copy like the other two lines.
 */
var ROOT_LINE_TAG = 'X-G247-Root';

/**
 * The ONLY tags that survive. Everything else is escaped and shown literally,
 * so a PM's unclosed <div or stray <script never reaches a client's mail
 * client as markup. Anchors are handled separately because they carry an
 * attribute; every other tag here is attribute-free by construction.
 */
var HTML_ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 'br', 'p',
  'ul', 'ol', 'li', 'blockquote'];

var RECIPIENT_BLOCKLIST = ['noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'bounce', 'notifications'];

/** Where self-mode copies and every health alert go. */
/**
 * HOW LONG TO WAIT FOR THE INTAKE TO ROOT A monday-CREATED PROJECT.
 *
 * A project created by hand on the board has no Gmail thread, so shouldRelay()
 * returns 'item-has-no-gmail-thread' and the email is dropped. The intake now
 * seeds an anchor for exactly this case when it sees the same monday automation
 * email in the PM's mailbox (its bypass rung), but the two scripts run on
 * independent 5-minute triggers and the relay may get there first.
 *
 * WHY THE RELAY DOES NOT SEED THIS ITSELF. It could: the send path needs only
 * headerMessageId, subject and mailbox, all of which it can read off the source
 * message. But the internal and client copies are separate script projects with
 * separate state, and they process different automation emails — so each would
 * seed from a different Message-ID and the two routes would end up threading a
 * monday-created project into two different conversations. The ledger is the
 * only place both can agree, and only the intake, which runs as the PM, can see
 * the PM-mailbox threadId a valid ledger anchor needs.
 *
 * So the relay waits instead. Within the window the message is left unprocessed
 * and the cursor is held; past it the message is treated normally (skipped),
 * because an item nobody ever seeds must not stall the cursor forever.
 */
var SEED_GRACE_MS = 30 * 60 * 1000;

var ALERT_EMAIL = 'msalvana@group247ww.com';

/** Header the intake already drops on, so a relayed copy is never re-ingested. */
var SYNC_HEADER_NAME = 'X-G247-Sync';
var SYNC_HEADER_VALUE = 'monday-relay';

/** Runaway brake. Same shape as the outbound bridge's. */
var RELAY_MAX_PER_HOUR = 40;
var RELAY_WINDOW_MS = 60 * 60 * 1000;
var PROP_RELAY_RATE = 'G247_RELAY_RATE';

/**
 * The client route gets its OWN counter, and a lower cap.
 *
 * Deferring internal chatter for an hour is harmless. Deferring a client's
 * approval request is not: "we will send it when the window rolls" is
 * indistinguishable, from the client's side, from never sending it. So hitting
 * this cap raises an alert rather than quietly waiting.
 */
var CLIENT_MAX_PER_HOUR = 20;
var PROP_CLIENT_RATE = 'G247_RELAY_RATE_CLIENT';

/** A client-route send may be attempted twice. Never more. */
var CLIENT_MAX_ATTEMPTS = 2;

/** A marker message with no state row after this long is presumed lost. */
var HEALTH_STALE_MS = 30 * 60 * 1000;

var MAX_BATCH = 25;

// ================================================================== PARSING

/**
 * monday addresses an item as pulse-<itemid>@<slug>.monday.com. That id is the
 * whole reason this works: it is an exact, machine-readable key straight to the
 * ledger, so nothing here has to match on subject text.
 * PURE.
 */
function extractPulseItemIds(addresses) {
  var out = [];
  var seen = {};
  (addresses || []).forEach(function (a) {
    var re = /pulse-(\d+)@[a-z0-9.\-]*monday\.com/gi;
    var m;
    while ((m = re.exec(String(a || ''))) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
    }
  });
  return out;
}

/** Every email address in a header value list. PURE. */
function extractAddresses(headerValues) {
  var out = [];
  (headerValues || []).forEach(function (v) {
    var re = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
    var m;
    while ((m = re.exec(String(v || ''))) !== null) { out.push(m[0].toLowerCase()); }
  });
  return out;
}

/** Is this one of ours? PURE. */
function isInternalAddress(addr) {
  var a = String(addr || '').toLowerCase();
  for (var i = 0; i < INTERNAL_DOMAINS.length; i++) {
    if (a.slice(-(INTERNAL_DOMAINS[i].length + 1)) === '@' + INTERNAL_DOMAINS[i]) { return true; }
  }
  return false;
}

/**
 * Which route does this message belong to?
 *
 * 'internal' — goes to the item and, at most, G247 people. Nothing has left the
 *              company. The approval, cancel and feedback automations.
 * 'client'   — at least one recipient outside G247. The Group Email route, the
 *              only one a client actually receives.
 * ''         — no item address at all, so there is no item id and nothing to
 *              match against. The Change Request and due-date automations fall
 *              here and CANNOT be relayed by this mechanism.
 * PURE.
 */
function classifyRoute(addresses) {
  var addrs = addresses || [];
  var pulses = 0;
  var external = 0;
  var marked = false;
  addrs.forEach(function (a) {
    var v = String(a || '').toLowerCase();
    if (/pulse-\d+@[a-z0-9.\-]*monday\.com/i.test(v)) { pulses++; return; }
    if (v === CLIENT_ROUTE_MARKER.toLowerCase()) { marked = true; return; }
    if (!isInternalAddress(v)) { external++; }
  });
  if (!pulses) { return ''; }

  // THE MARKER OUTRANKS THE DOMAIN RULE, and must. Once the client is removed
  // from an automation's recipients, everything left is internal-looking; the
  // marker is the only thing that still says "a client is meant to see this".
  if (marked) { return 'client'; }

  return external ? 'client' : 'internal';
}

/**
 * Who the relayed client copy is addressed to.
 *
 * The relay runs as projects@group247ww.com and CANNOT read the thread — it
 * lives in the PM's mailbox — so this list comes from the intake's ledger,
 * written when the project was created and rewritten on every reply.
 *
 * Everything removed here is removed for a reason:
 *   projects@   we are sending FROM it; mailing ourselves would loop
 *   pulse-*     monday's own address; relaying to it would create an update
 *               loop between the two systems
 *   the marker  a discard address, and a recipient of the original
 *   blocklist   automated senders that end up on threads
 * PURE.
 */
function clientRecipients(participants, pmMailbox) {
  var out = [];
  var seen = {};
  (participants || []).forEach(function (raw) {
    var a = String(raw || '').trim().toLowerCase();
    if (!a || seen[a]) { return; }
    if (a === String(EXPECTED_MAILBOX).toLowerCase()) { return; }
    if (a === String(CLIENT_ROUTE_MARKER).toLowerCase()) { return; }
    if (/pulse-\d+@[a-z0-9.\-]*monday\.com/i.test(a)) { return; }
    var local = a.split('@')[0];
    for (var i = 0; i < RECIPIENT_BLOCKLIST.length; i++) {
      if (local.indexOf(RECIPIENT_BLOCKLIST[i]) !== -1) { return; }
    }
    seen[a] = true;
    out.push(a);
  });

  // The PM belongs on their own project's client mail even if a stale
  // participant list has lost them. Added last so it never displaces a client.
  var pm = String(pmMailbox || '').trim().toLowerCase();
  if (pm && !seen[pm]) { out.push(pm); }

  return out;
}

/**
 * Pull the routing line out of a monday body.
 *
 * monday sends HTML, so the line arrives wrapped in markup and entities and
 * possibly split across tags: <div>X-G247-Recipients: a@b.com,&nbsp;c@d.com</div>
 * Tags are flattened to spaces first so a tag boundary cannot glue two
 * addresses together or hide the tag itself.
 *
 * Returns [] when the line is absent or empty — the caller must treat that as a
 * refusal to send, never as "no extra recipients".
 * PURE.
 */
function parseRecipientsLine(html, text) {
  var sources = [String(html || ''), String(text || '')];
  for (var i = 0; i < sources.length; i++) {
    var flat = sources[i]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      // Collapse SPACES AND TABS ONLY. Newlines are load-bearing: they
      // terminate the line in the plain-text part, and collapsing them let the
      // match run on into the body and swallow the next address it found.
      .replace(/[^\S\r\n]+/g, ' ');
    var re = new RegExp(RECIPIENTS_LINE_TAG + '\\s*:([^<\\n\\r]*)', 'i');
    var m = re.exec(flat);
    if (!m) { continue; }

    // Only up to the end of the line's addresses. Anything after the last
    // address on that line is body text, not a recipient.
    var out = [];
    var seen = {};
    var ar = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
    var a;
    while ((a = ar.exec(m[1])) !== null) {
      var v = a[0].toLowerCase();
      if (seen[v]) { continue; }
      seen[v] = true;
      out.push(v);
    }
    if (out.length) { return out; }
  }
  return [];
}

/**
 * Remove the routing line from a body before it is sent on.
 *
 * THE CLIENT MUST NEVER SEE THIS. It is internal plumbing, it names everyone
 * else on the distribution, and a leak is visible in their inbox and cannot be
 * recalled. Removal happens on both the HTML and plain-text parts because
 * either may be what their client renders.
 * PURE.
 */
function stripTaggedLine(body, tag) {
  var s = String(body || '');
  if (!s || !tag) { return s; }

  // The whole element that contains the tag, when it sits in its own block.
  s = s.replace(new RegExp('<(p|div|span|td|tr|li)[^>]*>\\s*(?:<[^>]*>\\s*)*' +
    tag + '[\\s\\S]*?</\\1>', 'gi'), '');

  // Otherwise the run of text from the tag to the end of its line or element.
  // THE LINE'S OWN NEWLINE GOES WITH IT. Leaving it behind donates a blank line
  // to the relayed body for every plumbing line stripped — invisible in the
  // <pre> path, but four trailing <br> in the rendered path.
  s = s.replace(new RegExp(tag + '\\s*:[^<\\n\\r]*(?:\\r?\\n)?', 'gi'), '');

  return s;
}

/** Both plumbing lines removed. The only stripper the send path should call. */
function stripRelayPlumbing(body) {
  var s = body;
  [RECIPIENTS_LINE_TAG, HTML_LINE_TAG, ROOT_LINE_TAG].forEach(function (tag) {
    s = stripTaggedLine(s, tag);
  });
  return s;
}

function stripRecipientsLine(body) {
  return stripTaggedLine(body, RECIPIENTS_LINE_TAG);
}

// ================================================================ FORMATTING

/** Message-IDs compare bare and case-folded: <A@b> and a@b are the same id. PURE. */
function sameMessageId(a, b) {
  var norm = function (v) {
    return String(v === null || v === undefined ? '' : v)
      .trim().replace(/^<|>$/g, '').toLowerCase();
  };
  var x = norm(a);
  return !!x && x === norm(b);
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Did the automation body ask for HTML?
 *
 * Reads the same way as the routing line: flatten any markup, find the tag,
 * take the rest of that line. Only an explicit affirmative counts. An
 * unresolved monday token ("[Item's ...]", "{{item.x}}") is NOT affirmative —
 * that mistake is exactly how the routing line silently fell back for two days.
 * PURE.
 */
function parseFlagLine(tag, html, text) {
  var sources = [String(html || ''), String(text || '')];
  for (var i = 0; i < sources.length; i++) {
    var flat = sources[i]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[^\S\r\n]+/g, ' ');
    var m = new RegExp(tag + '\\s*:([^<\\n\\r]*)', 'i').exec(flat);
    if (!m) { continue; }
    var v = String(m[1] || '').trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') { return true; }
    return false;   // present but not affirmative — do not try the other part
  }
  return false;
}

function parseHtmlOptIn(html, text) { return parseFlagLine(HTML_LINE_TAG, html, text); }

/** Did a PM deliberately mark this email as the root of the project's thread? PURE. */
function parseRootMarker(html, text) { return parseFlagLine(ROOT_LINE_TAG, html, text); }

/**
 * Render a PLAIN-TEXT body that was authored as HTML.
 *
 * DEFAULT DENY. Everything is escaped first, then the whitelist is un-escaped —
 * never the reverse. Un-escaping a whitelist can only ever let through tags on
 * the list; stripping a blacklist lets through everything nobody thought of.
 * This text is written by PMs and read by clients, so it gets the paranoid
 * direction.
 *
 * Newlines become <br> because the author wrote plain text: their paragraph
 * breaks are line breaks, and HTML would collapse them to nothing. This is why
 * sniffing for tags would not have been enough on its own — the layout needs
 * converting too, not just the markup preserving.
 * PURE.
 */
function renderAuthoredHtml(text) {
  // Trailing whitespace is never meaningful and always shows: the plumbing
  // lines sit at the foot of the body, so whatever blank lines preceded them
  // would otherwise close every client email with a run of empty <br>.
  var esc = escapeHtml(String(text === null || text === undefined ? '' : text)
    .replace(/\s+$/, ''));

  var allowed = {};
  HTML_ALLOWED_TAGS.forEach(function (t) { allowed[t] = true; });

  var out = '';
  var stack = [];        // tags actually opened, innermost last
  var last = 0;
  // Every escaped tag-shaped run. Attributes may contain &amp; from escaping,
  // so the scan stops at the first &gt; rather than the first &.
  var re = /&lt;(\/?)([a-z][a-z0-9]*)([^\n\r]*?)&gt;/gi;
  var m;

  while ((m = re.exec(esc)) !== null) {
    out += esc.slice(last, m.index);
    last = re.lastIndex;

    var closing = m[1] === '/';
    var name = m[2].toLowerCase();
    var attrs = m[3] || '';
    var literal = m[0];

    if (name !== 'a' && !allowed[name]) { out += literal; continue; }

    if (closing) {
      // ORPHAN CLOSERS ARE DELETED, NOT SHOWN. A rejected opener — an anchor
      // whose monday token resolved to href="", a <b> carrying an attribute —
      // leaves its closer behind, and printing &lt;/a&gt; at a client is the
      // exact artefact this whole function exists to prevent. A PM writing a
      // bare "</a>" as literal prose does not happen; unresolved tokens do.
      var at = stack.lastIndexOf(name);
      if (at === -1) { continue; }
      while (stack.length > at) { out += '</' + stack.pop() + '>'; }
      continue;
    }

    if (name === 'a') {
      var href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      var h = href ? String(href[1] !== undefined ? href[1] : href[2]).trim() : '';
      // Empty, whitespace-only, relative, or an untrusted scheme: the anchor is
      // dropped and its label survives as plain text. A dead link is worse than
      // no link — a client clicks it and nothing happens.
      if (/^(https?:\/\/|mailto:)\S+$/i.test(h)) {
        out += '<a href="' + h + '">';
        stack.push('a');
      }
      continue;
    }

    // Every other whitelisted tag is attribute-free by construction. One that
    // arrives carrying attributes is not the tag we whitelisted, so it is shown
    // literally rather than sanitised into something the author did not write.
    if (/\S/.test(attrs.replace(/\/\s*$/, ''))) { out += literal; continue; }

    if (name === 'br') { out += '<br>'; continue; }
    out += '<' + name + '>';
    stack.push(name);
  }
  out += esc.slice(last);

  // Anything the author left open, we close. Well-formed markup costs nothing
  // and unbalanced tags render differently in every mail client.
  while (stack.length) { out += '</' + stack.pop() + '>'; }

  // The author's line breaks. Done last so it cannot disturb tag matching.
  return out.replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * The thread's subject, exactly as the root has it — no "Re:" prefix.
 *
 * The prefix used to be added so the copy read as a reply. It isn't needed
 * for threading: Gmail and Outlook thread on In-Reply-To/References, and both
 * ignore Re:/Fwd: prefixes when comparing subjects. What it did do was hand
 * every client their first email on a project with "Re:" in front of the
 * project name, which reads as a reply to something they never saw. The
 * client's own reply adds the prefix naturally.
 */
function replySubject(subject) {
  var s = String(subject || '').trim() || '(no subject)';
  return s.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim() || '(no subject)';
}

function encodeSubject(subject, b64) {
  var s = String(subject || '');
  if (/^[\x20-\x7e]*$/.test(s)) { return s; }
  return '=?UTF-8?B?' + b64(s) + '?=';
}

/**
 * Build the relayed message.
 *
 * SUBJECT IS THE THREAD'S, NOT THE AUTOMATION'S — this is load-bearing.
 * Gmail does not thread on References alone; a materially different subject
 * splits the conversation even when the headers are right. monday's subjects
 * ("Project X - pls review & approve/reject - thx") bear no relation to the
 * original email subject, so using them would put every relayed message in its
 * own new thread and defeat the entire point. The automation's own subject is
 * preserved as the first line of the body instead, where it loses nothing.
 * PURE.
 */
function buildRelayMime(a, b64) {
  var lines = [];
  lines.push('To: ' + a.to);
  lines.push('Subject: ' + encodeSubject(replySubject(a.threadSubject), b64));
  // REPLY-TO IS WHAT KEEPS THE LOOP CLOSED, ON BOTH ROUTES.
  //
  // The copy is sent from projects@, which no PM reads and which the intake —
  // running as the PM — would never ingest. Without this header a reply lands
  // there and silently never reaches the monday item.
  //
  // It used to be set on the client route only, on the reasoning that the
  // internal route already mails the PM directly. But a PM replying to an
  // internal notification hit the same dead end: no Reply-To, so plain Reply
  // went to projects@ and was lost. Pointed at the PM it lands back in their
  // own mailbox on a thread the ledger knows, which the intake appends to the
  // item — so replying to a notification becomes a way to add a note.
  if (a.replyTo) { lines.push('Reply-To: ' + a.replyTo); }
  var ref = '<' + String(a.headerMessageId || '').replace(/^<|>$/g, '') + '>';
  lines.push('In-Reply-To: ' + ref);
  lines.push('References: ' + ref);
  lines.push(SYNC_HEADER_NAME + ': ' + SYNC_HEADER_VALUE);
  lines.push('X-G247-Item: ' + (a.itemId || ''));
  lines.push('X-G247-Route: ' + (a.route || ''));
  lines.push('X-G247-Source: ' + (a.sourceMessageId || ''));
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('');
  lines.push(relayBody(a));
  return lines.join('\r\n');
}

/**
 * The automation's own subject as a heading, then monday's message.
 *
 * WHAT THIS DELIBERATELY DOES NOT SAY. It used to carry "monday automation ·
 * item <id>" and "sent to <addresses>". Both went to clients: the first shows
 * them an internal record id and tells them they are looking at machine output,
 * and the second shows every client on a project the other clients' addresses.
 * Neither was ever for them — it was diagnostics, and diagnostics belong in the
 * state sheet, which records itemId, toMailbox and detail on every send.
 *
 * The subject stays because the thread's own subject is the project name, so
 * without it nothing distinguishes an approval request from a rejection notice.
 * PURE.
 */
function relayBody(a) {
  // ONE CENTRED 600px COLUMN, the way every transactional email is built:
  // an outer full-width table to centre, an inner fixed-width table to hold
  // the content. Tables and inline styles because that is the only layout
  // Gmail, Outlook and Apple Mail all agree on; Gmail strips <style> blocks.
  var head = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
    'style="width:100%;margin:0 0 20px 0;border-collapse:separate">' +
    '<tr><td align="left" valign="middle" style="border-radius:6px;' +
    'background:#f9e2d5;background-color:#f9e2d5;' +
    'padding-top:20px;padding-bottom:20px;padding-left:24px;padding-right:24px;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;' +
    'color:#222;line-height:22px;mso-line-height-rule:exactly;text-align:left">' +
    // A subject folded over two header lines arrives with CRLF + space inside
    // it; collapsed by the browser, but trimmed here so nothing can pad the box.
    escapeHtml(String(a.originalSubject || '(no subject)').replace(/\s+/g, ' ').trim()) +
    '</td></tr></table>';

  // A real text/html part always wins — it is already markup and needs no
  // reconstruction. The opt-in only rescues the text/plain-only case, which is
  // every message monday actually sends.
  var body;
  if (a.html) { body = a.html; }
  else if (a.htmlOptIn) { body = renderAuthoredHtml(a.text || ''); }
  else { body = '<pre style="white-space:pre-wrap">' + escapeHtml(a.text || '') + '</pre>'; }

  // No logo, no dark frame, no card border — Mark's call on 15 Sep. The
  // heading box is the one piece of styling that stays. LOGO_URL is kept so
  // it can come back with a one-line change.
  var logo = '';

  // Full width, left-aligned, like an ordinary email. The only styled element
  // is the heading box.
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">' +
    head + body + '</div>';
}

// ================================================================= DATES

/**
 * DATES READ AS "ddd DD MMM", e.g. "Thu 24 Sep". Mark's call, 23 Sep 2026:
 * strictly that, no year, ever.
 *
 * WHERE. monday writes a date chip out in whatever format the automation
 * creator's account uses ("24 September 2026" on the 23 Sep kick-off), so the
 * only place every automation passes through is here.
 *
 * WHAT IS REWRITTEN. Only dates that carry a year, because the weekday cannot
 * be worked out without one:
 *   24 September 2026 / 24 Sep 2026 / 24th Sep, 2026
 *   September 24, 2026 / Sep 24 2026
 *   2026-09-24
 * A weekday already in front ("Thursday, 24 September 2026") is absorbed, so
 * it never reads "Thursday, Thu 24 Sep".
 *
 * WHAT IS LEFT ALONE, deliberately:
 *   24/09/2026, 09/24/2026  ambiguous: 24 Sep or 9 Dec? A wrong date sent to a
 *                           client is worse than an ugly one.
 *   24 September            no year, so no weekday.
 *   31 February 2026        not a real date; shown as written.
 *   anything inside a tag   an href or attribute is never touched, so links
 *                           that contain dates keep working.
 *   2026-09-16 1557         a Drive round-folder name, not a date.
 *   the thread subject      Gmail threads on it; only the heading is changed.
 * PURE.
 */
var DATE_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
var DATE_MON_OUT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DATE_DAY_OUT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

var DATE_WD = '(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?';
var DATE_MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|' +
  'july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)' +
  '(?![a-z])\\.?';
var DATE_DD = '(\\d{1,2})(?:st|nd|rd|th)?';

var DATE_RE_DMY = new RegExp('\\b' + DATE_WD + DATE_DD + '\\s+' + DATE_MON +
  ',?\\s+(\\d{4})(?!\\d)', 'gi');
var DATE_RE_MDY = new RegExp('\\b' + DATE_WD + DATE_MON + '\\s+' + DATE_DD +
  ',?\\s+(\\d{4})(?!\\d)', 'gi');
var DATE_RE_ISO = /(?<![\w\/.:=?&#-])(\d{4})-(\d{2})-(\d{2})(?![\w\/-]|T\d|\s+\d{3,4}(?!\d))/g;

/** "Thu 24 Sep", or null when y/m/d is not a real date. PURE. */
function shortDate(y, m, d) {
  var dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) {
    return null;
  }
  return DATE_DAY_OUT[dt.getUTCDay()] + ' ' + (d < 10 ? '0' : '') + d + ' ' + DATE_MON_OUT[m];
}

/** Rewrite the dates in a run of text that contains no markup. PURE. */
function formatDatesInText(s) {
  return String(s)
    .replace(DATE_RE_DMY, function (all, d, mon, y) {
      return shortDate(+y, DATE_MONTHS[mon.slice(0, 3).toLowerCase()], +d) || all;
    })
    .replace(DATE_RE_MDY, function (all, mon, d, y) {
      return shortDate(+y, DATE_MONTHS[mon.slice(0, 3).toLowerCase()], +d) || all;
    })
    .replace(DATE_RE_ISO, function (all, y, m, d) {
      return shortDate(+y, +m - 1, +d) || all;
    });
}

/**
 * Same, for a body that may contain markup: only the text BETWEEN tags is
 * touched, so an href or attribute holding a date is never rewritten.
 * PURE.
 */
function formatDates(body) {
  if (body === null || body === undefined || body === '') { return body; }
  return String(body).split(/(<[^>]*>)/).map(function (part) {
    return part.charAt(0) === '<' ? part : formatDatesInText(part);
  }).join('');
}

// =============================================================== RATE LIMIT

function relayRateGate(store, nowMs, limit, windowMs, key) {
  key = key || PROP_RELAY_RATE;
  var raw = store.get(key);
  var st;
  try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
  if (!st || typeof st.windowStart !== 'number' || (nowMs - st.windowStart) >= windowMs) {
    st = { windowStart: nowMs, count: 0 };
  }
  if (st.count >= limit) { return { allow: false, count: st.count, commit: function () {} }; }
  return {
    allow: true,
    count: st.count,
    commit: function () { st.count++; st.lastAt = nowMs; store.set(key, JSON.stringify(st)); }
  };
}

// ================================================================= DECISION

/**
 * Should this sent message be relayed, and if not, why not?
 * PURE — every input injected, so every branch is testable without a mailbox.
 *
 * @param {Object} m  {id, addresses, subject, syncHeader}
 * @param {Object} ctx {route, anchorFor(itemId), alreadyRelayed}
 */
function shouldRelay(m, ctx) {
  m = m || {}; ctx = ctx || {};

  // Never relay our own relays, or anything the bridge sent. Without this a
  // relayed copy landing back in this mailbox would be relayed again.
  if (m.syncHeader) { return { relay: false, reason: 'already-carries-sync-header' }; }

  var route = classifyRoute(m.addresses);
  if (!route) { return { relay: false, reason: 'no-monday-item-address' }; }
  if (route !== ctx.route) { return { relay: false, reason: 'other-route:' + route }; }

  var ids = extractPulseItemIds(m.addresses);
  if (ids.length !== 1) {
    return { relay: false, reason: ids.length ? 'ambiguous-multiple-items' : 'no-item-id' };
  }

  // PRIOR ATTEMPTS.
  //
  // 'sent'    done.
  // 'sending' recorded before the send, so the outcome is UNKNOWN — the pass
  //           may have died between writing the row and Gmail accepting the
  //           message. Never retried: a duplicate email to a client cannot be
  //           recalled, and record-before-send exists precisely to buy that.
  //           relayHealth() surfaces it for a human instead.
  // 'FAILED'  the send threw, so nothing went out. Safe to retry — and on the
  //           client route, necessary: "not retried" means a client never hears
  //           about their approval.
  var prior = ctx.priorAttempts ||
    (ctx.alreadyRelayed ? { last: 'sent', failures: 0 } : null);
  if (prior && prior.last) {
    if (prior.last === 'sent') { return { relay: false, reason: 'already-relayed' }; }
    if (prior.last === 'sending') { return { relay: false, reason: 'in-flight-outcome-unknown' }; }
    if (prior.last === 'FAILED') {
      if (ctx.route !== 'client') { return { relay: false, reason: 'failed-not-retried' }; }
      if ((prior.failures || 0) >= CLIENT_MAX_ATTEMPTS) {
        return { relay: false, reason: 'retries-exhausted' };
      }
    }
  }

  var anchor = ctx.anchorFor(ids[0]);
  if (!anchor || !anchor.threadId || !anchor.headerMessageId || !anchor.mailbox) {
    // Expected and common: only projects the intake created from a labelled
    // email have a Gmail thread. Everything older has nowhere to go.
    return { relay: false, reason: 'item-has-no-gmail-thread', itemId: ids[0] };
  }

  // THIS MESSAGE IS THE THREAD ROOT — DO NOT ECHO IT.
  //
  // A kick-off email addressed at the item roots the project's thread, and the
  // intake indexes that same message as the anchor. Without this the relay then
  // "relays" the root: a second copy, In-Reply-To itself, to people who already
  // have it. On the client route that is a duplicate email to a client, which
  // cannot be recalled.
  if (sameMessageId(m.headerMessageId, anchor.headerMessageId)) {
    return { relay: false, reason: 'is-the-thread-root', itemId: ids[0] };
  }

  // The internal route goes to the PM alone, exactly as it does today.
  if (ctx.route !== 'client') {
    return { relay: true, reason: 'ok', itemId: ids[0], anchor: anchor,
             recipients: [anchor.mailbox] };
  }

  // WHERE THE CLIENT COMES FROM.
  //
  // The routing line is the source of truth: monday reads it off the item at
  // send time, so it is current by construction. The ledger's participants are
  // a fallback for the case the line is absent — but the 23 August audit says
  // that fallback reaches no real client on any project, so it is a safety net
  // that is expected to catch nothing, not a second mechanism.
  var fromLine = m.recipientsLine || [];
  var source = fromLine.length ? 'body-line' : 'ledger-participants';
  var raw = fromLine.length
    ? fromLine
    : (ctx.participantsFor ? ctx.participantsFor(anchor.threadId) : []);

  var people = clientRecipients(raw, anchor.mailbox);
  if (!people.length) {
    return { relay: false, reason: 'no-recipients-in-ledger', itemId: ids[0] };
  }

  // NO CLIENT IS A LEGITIMATE STATE, NOT A FAILURE. (Changed 24 Aug.)
  //
  // This guard used to refuse to send when nobody outside G247 was addressed,
  // on the reasoning that an all-internal send means the client was meant to
  // receive something and did not. The routing line removes that ambiguity: it
  // is read off C. Email at send time, so an empty result means this project
  // genuinely has no client contact — typically one created by hand rather than
  // through the bridge. Those still need to reach the item and the PM.
  //
  // So the relay always sends, and records how many outside recipients there
  // were. A run with clients=0 is auditable without being blocked.
  var outsiders = people.filter(function (a) { return !isInternalAddress(a); });

  return { relay: true, reason: 'ok', itemId: ids[0], anchor: anchor,
           recipients: people, outsiders: outsiders, recipientSource: source };
}

// ==================================================================== HEALTH

/**
 * THE COMPENSATING CONTROL.
 *
 * Once monday stops emailing the client directly, this script is the only thing
 * standing between an approval request and a client who never hears about it.
 * A relay that dies produces no error anywhere — it simply stops, and every
 * symptom is an absence. So something has to look for the absence.
 *
 * Two questions, and the second is the one that matters:
 *   1. is any client-route message recorded as something other than sent?
 *   2. did a client-facing automation go out with NO row at all?
 *
 * (2) is what catches a dead trigger, an expired authorisation, or a pass that
 * never ran. (1) alone would report a clean bill of health on a relay that has
 * not executed in a week.
 * PURE.
 *
 * @param {Array} rows      state-sheet rows
 * @param {Array} markerMsgs [{id, ts}] sent mail addressed to CLIENT_ROUTE_MARKER
 * @param {number} nowMs
 */
function healthCheck(rows, markerMsgs, nowMs) {
  var out = { ok: true, checkedRows: 0, checkedMessages: 0, stuck: [], lost: [], skipped: {} };
  var bySource = {};

  (rows || []).forEach(function (r) {
    if (String(r.route || '') !== 'client') { return; }
    out.checkedRows++;
    var id = String(r.sourceMessageId || '');
    var res = String(r.result || '');
    bySource[id] = res;
  });

  Object.keys(bySource).forEach(function (id) {
    var res = bySource[id];
    if (res === 'sent' || res === 'sent-self') { return; }
    // A recorded skip is a decision, not a failure: the relay ran, looked, and
    // chose not to send. Counted so the report can say so, never "stuck".
    if (res === 'root-seen') { return; }
    if (res.indexOf('skipped:') === 0) {
      var why = res.slice('skipped:'.length);
      out.skipped[why] = (out.skipped[why] || 0) + 1;
      return;
    }
    out.stuck.push({ sourceMessageId: id, result: res || '(blank)' });
  });

  (markerMsgs || []).forEach(function (m) {
    out.checkedMessages++;
    var id = String(m.id || '');
    if (bySource[id] !== undefined) { return; }
    var age = nowMs - Number(m.ts || 0);
    if (age < HEALTH_STALE_MS) { return; }   // still within the relay's window
    out.lost.push({ sourceMessageId: id, ageMinutes: Math.round(age / 60000) });
  });

  out.ok = (out.stuck.length === 0 && out.lost.length === 0);
  return out;
}

/** Format a health report as something a human reads at 8am. PURE. */
function healthMessage(h) {
  var skips = Object.keys(h.skipped || {}).map(function (k) {
    return h.skipped[k] + ' x ' + k;
  });
  var skipLine = skips.length
    ? ' Deliberately skipped: ' + skips.join(', ') + ' (see the state sheet).' : '';
  if (h.ok) {
    return 'Client relay healthy. ' + h.checkedRows + ' relayed message(s) on record, ' +
      h.checkedMessages + ' client automation(s) seen, none unaccounted for.' + skipLine;
  }
  var out = ['CLIENT RELAY NEEDS ATTENTION.', ''];
  if (skipLine) { out.push(skipLine.trim(), ''); }
  if (h.lost.length) {
    out.push('NOT RELAYED AT ALL — a client automation was sent and this script ' +
      'never recorded it. The relay may not be running:');
    h.lost.forEach(function (l) {
      out.push('  ' + l.sourceMessageId + '  (' + l.ageMinutes + ' minutes ago)');
    });
    out.push('');
  }
  if (h.stuck.length) {
    out.push('RECORDED BUT NOT SENT:');
    h.stuck.forEach(function (t) {
      out.push('  ' + t.sourceMessageId + '  -> ' + t.result);
    });
    out.push('');
    out.push('A row reading "sending" means the outcome is unknown: the pass died ' +
      'between recording and sending. Check the mailbox before re-sending by ' +
      'hand — a duplicate to a client cannot be recalled.');
  }
  return out.join('\n');
}

/**
 * Items that a kick-off in THIS batch is about to root.
 *
 * The kick-off is split in two, both fired by the same column change:
 *
 *   1. the ROOT email — PM and pulse-<item>@ only, carrying X-G247-Root. The
 *      client never sees it; it exists so the intake can anchor the project.
 *   2. the CLIENT kick-off — an ordinary client-route automation, which the
 *      relay threads onto (1) and sends with a correct Reply-To.
 *
 * (2) deliberately does NOT carry the root marker: it never reaches the PM's
 * mailbox, so it could not root anything, and giving it the marker would make
 * one line mean two different things. But without it the relay would drop (2)
 * on the pass before the intake has anchored (1) — the client's kick-off, gone
 * silently, which is the failure mode this whole system keeps producing.
 *
 * So the batch is read twice. Anything a young root email in this same window
 * is about to anchor waits with it, and they are released together.
 * PURE.
 */
function itemsAwaitingRoot(metas, nowMs, graceMs, rememberedRoots) {
  var out = {};
  (metas || []).forEach(function (m) {
    if (!m || !m.ok || m.rootMarker !== true) { return; }
    if (!m.internalDate || (nowMs - m.internalDate) >= graceMs) { return; }
    extractPulseItemIds(m.addresses).forEach(function (id) { out[String(id)] = true; });
  });
  // ROOTS SEEN ON AN EARLIER PASS. At a 1-minute poll the root and the client
  // half usually land in DIFFERENT passes: the root at :39, the client half at
  // :41 after the PM flips the column. On 14 Sep (P261483) the client half was
  // read alone, nothing in its batch carried the marker, and it was dropped as
  // 'item-has-no-gmail-thread' twelve seconds before the intake rooted the
  // project. The state sheet now remembers each root it has seen, and a young
  // one counts here exactly as if it were in the batch.
  (rememberedRoots || []).forEach(function (r) {
    if (!r || !r.itemId || !r.ts) { return; }
    if ((nowMs - r.ts) >= graceMs) { return; }
    out[String(r.itemId)] = true;
  });
  return out;
}

// ============================================================== ORCHESTRATOR

/**
 * One pass. Every service injected, so the failure paths run under Node.
 * @param {Object} deps {gmail, ledger, state, props, store, now, nowMs, b64, log}
 * @param {Object} opts {dryRun}
 */
function runRelayPass(deps, opts) {
  opts = opts || {};
  var summary = { route: ROUTE, mode: '', scanned: 0, relayed: 0, skipped: 0,
                  failed: 0, seeded: false, noClient: 0, reasons: {} };

  // off  = nothing sent.
  // self = built and sent, but addressed to ALERT_EMAIL only, so the client
  //        copy can be read exactly as the client would read it before a
  //        client ever receives one. Everything else is identical.
  // on   = live.
  var mode = String(deps.props.get(PROP_RELAY_MODE) || 'off').toLowerCase();
  summary.mode = mode;
  if (mode !== 'on' && mode !== 'self') { return summary; }

  // Identity before anything else — see EXPECTED_MAILBOX.
  var who = String(deps.gmail.profile() || '').toLowerCase();
  if (who !== EXPECTED_MAILBOX.toLowerCase()) {
    summary.wrongMailbox = who || '(unknown)';
    deps.log('error', 'REFUSING TO RUN: this pass is running as ' + who +
      ', not ' + EXPECTED_MAILBOX + '. Sign in as that account and install the ' +
      'trigger there — sharing the project is not the same as running as it.');
    return summary;
  }

  function note(reason) {
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
    summary.skipped++;
  }

  var cursor = deps.state.getCursor(CURSOR_KEY);

  // FIRST RUN SEEDS AND RELAYS NOTHING — otherwise switching this on would
  // replay every historical automation email into live client threads.
  //
  // A DRY RUN MUST NOT SEED. Writing the cursor is a state change, and a dry run
  // that changes state is a lie: you would preview, see "seeded", and have
  // silently moved the starting point without sending anything. Report what it
  // WOULD do and leave the cursor alone.
  if (!cursor) {
    if (opts.dryRun) {
      summary.wouldSeed = true;
      deps.log('info', 'DRY RUN: cursor is unseeded. A real run would seed it at the ' +
        'current history id and relay nothing. No cursor was written.');
      return summary;
    }
    deps.state.setCursor(CURSOR_KEY, deps.gmail.currentHistoryId());
    summary.seeded = true;
    return summary;
  }

  var page = deps.gmail.historyList(cursor);
  var ids = (page.messageIds || []);
  summary.scanned = ids.length;

  // THE CURSOR MOVES ONLY IF THE WHOLE PAGE WAS PROCESSED.
  // It used to advance unconditionally, so the rate-cap break and the MAX_BATCH
  // truncation both discarded every message they had not reached — while the
  // rate-cap alert told a human the mail was "waiting". Re-reading a window is
  // free: anything already sent comes back 'already-relayed' from the state
  // sheet, which is what makes not advancing safe.
  var pageDrained = !page.hasMore && ids.length <= MAX_BATCH;

  // Fetched up front rather than inside the loop: the batch has to be read
  // twice, once to find what is mid-rooting and once to act. Same number of
  // fetches, just ordered differently.
  var metas = [];
  for (var f = 0; f < ids.length && f < MAX_BATCH; f++) {
    metas.push(deps.gmail.messageMeta(ids[f]));
  }
  // Remember every root in this batch before deciding anything, so the client
  // half — this pass or a later one — can wait for it. Once per root.
  metas.forEach(function (m) {
    if (!m || !m.ok || m.rootMarker !== true) { return; }
    var prior = deps.store.attemptsFor(m.id);
    if (prior && prior.last === 'root-seen') { return; }
    var rootItems = extractPulseItemIds(m.addresses);
    if (!rootItems.length) { return; }
    deps.store.record({
      ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: rootItems[0],
      toMailbox: '', threadId: '', subject: m.subject, relayedMessageId: '',
      result: 'root-seen', detail: ''
    });
  });
  var remembered = deps.store.recentRoots ? deps.store.recentRoots() : [];
  var awaitingRoot = itemsAwaitingRoot(metas, deps.nowMs(), SEED_GRACE_MS, remembered);

  for (var i = 0; i < metas.length; i++) {
    var m = metas[i];
    if (!m || !m.ok) { note('fetch-failed'); continue; }

    var verdict = shouldRelay(m, {
      route: ROUTE,
      priorAttempts: deps.store.attemptsFor(m.id),
      anchorFor: function (itemId) { return deps.ledger.itemThread(itemId); },
      participantsFor: function (threadId) { return deps.ledger.threadParticipants(threadId); }
    });

    // AWAITING A SEED. Young enough that the intake has probably not run yet:
    // leave the message alone and hold the cursor so the next pass sees it
    // again with an anchor in place. Deliberately a `continue`, not a `break` —
    // breaking would park every other item behind one unrooted project for the
    // whole grace window.
    if (!verdict.relay && verdict.reason === 'item-has-no-gmail-thread' &&
        (m.rootMarker === true || awaitingRoot[String(verdict.itemId)] === true) &&
        m.internalDate && (deps.nowMs() - m.internalDate) < SEED_GRACE_MS) {
      note('awaiting-intake-seed');   // only ever a kick-off; see ROOT_LINE_TAG
      pageDrained = false;
      deps.log('info', 'item ' + verdict.itemId + ' has no anchor yet and this ' +
        'automation email is ' + Math.round((deps.nowMs() - m.internalDate) / 1000) +
        's old — holding for the intake to root it.');
      continue;
    }

    if (!verdict.relay) {
      note(verdict.reason);
      if (RECORDED_SKIPS[verdict.reason] === true) {
        // ONCE per message and reason: a re-read window must not append the
        // same skip again, and a later real send must still be possible —
        // shouldRelay() only reacts to 'sent', 'sending' and 'FAILED'.
        var priorSkip = deps.store.attemptsFor(m.id);
        if (!priorSkip || priorSkip.last !== 'skipped:' + verdict.reason) {
          deps.store.record({
            ts: deps.now(), route: ROUTE, sourceMessageId: m.id,
            itemId: verdict.itemId || '', toMailbox: '', threadId: '',
            subject: m.subject, relayedMessageId: '',
            result: 'skipped:' + verdict.reason, detail: ''
          });
        }
      }
      continue;
    }

    var isClient = (ROUTE === 'client');
    var cap = isClient ? CLIENT_MAX_PER_HOUR : RELAY_MAX_PER_HOUR;
    var gate = relayRateGate(deps.props, deps.nowMs(),
      cap, RELAY_WINDOW_MS, isClient ? PROP_CLIENT_RATE : PROP_RELAY_RATE);
    if (!gate.allow) {
      summary.rateCapped = true;
      deps.log('warn', 'relay hit ' + cap + '/hour cap; stopping this pass');
      // On the internal route a deferral is harmless. On the client route it is
      // indistinguishable, from the client's side, from never sending at all,
      // so somebody is told.
      if (isClient) { deps.alert('G247 relay: CLIENT rate cap hit',
        'The client relay hit its ' + cap + '/hour cap and stopped this pass. ' +
        'Approval emails are waiting and will not go out until the window ' +
        'rolls. Check the relay state sheet.'); }
      pageDrained = false;   // cursor stays put — genuinely retried next window
      break;
    }

    if (!(verdict.outsiders || []).length) {
      summary.noClient++;
      deps.log('info', 'item ' + verdict.itemId + ' has no client contact — ' +
        'relaying to the PM and the item only. Expected on projects created by ' +
        'hand rather than through the bridge.');
    }

    var recipients = (verdict.recipients || []).slice();
    var selfMode = (mode === 'self');
    var toLine = selfMode ? ALERT_EMAIL : recipients.join(', ');

    var raw = buildRelayMime({
      to: toLine,
      replyTo: verdict.anchor.mailbox,
      threadSubject: verdict.anchor.subject,
      headerMessageId: verdict.anchor.headerMessageId,
      itemId: verdict.itemId,
      route: ROUTE,
      sourceMessageId: m.id,
      originalSubject: formatDates(m.subject),
      sentTo: (ROUTE === 'client' ? (verdict.outsiders || []) :
        (m.addresses || []).filter(function (a) {
          return !/pulse-\d+@/i.test(a) &&
                 String(a).toLowerCase() !== CLIENT_ROUTE_MARKER.toLowerCase();
        })).join(', '),
      // STRIPPED. The routing line is plumbing and names the whole
      // distribution; the client must never see it, and a sent mail cannot be
      // recalled.
      html: formatDates(stripRelayPlumbing(m.bodyHtml)),
      text: formatDates(stripRelayPlumbing(m.bodyText)),
      htmlOptIn: m.htmlOptIn === true
    }, deps.b64);

    if (opts.dryRun) {
      deps.log('info', 'DRY RUN would relay "' + m.subject + '" (item ' + verdict.itemId +
        ') to ' + toLine + ' — thread ' + verdict.anchor.threadId +
        (selfMode ? '  [SELF MODE: the real recipients would be ' +
          recipients.join(', ') + ']' : ''));
      summary.relayed++;
      continue;
    }

    // RECORD BEFORE SEND. A duplicate email cannot be recalled; a missing one
    // can be re-sent by hand. Same rule as the outbound bridge.
    deps.store.record({
      ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: verdict.itemId,
      toMailbox: toLine, threadId: verdict.anchor.threadId,
      subject: m.subject, relayedMessageId: '', result: 'sending',
      detail: selfMode ? 'self mode; live recipients would be ' + recipients.join(', ') : ''
    });

    try {
      var sent = deps.gmail.sendRaw(raw);
      gate.commit();
      summary.relayed++;
      deps.store.record({
        ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: verdict.itemId,
        toMailbox: toLine, threadId: verdict.anchor.threadId,
        subject: m.subject, relayedMessageId: sent,
        result: selfMode ? 'sent-self' : 'sent',
        detail: (verdict.recipientSource || '') +
          '; clients=' + ((verdict.outsiders || []).length)
      });
    } catch (e) {
      summary.failed++;
      deps.store.record({
        ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: verdict.itemId,
        toMailbox: toLine, threadId: verdict.anchor.threadId,
        subject: m.subject, relayedMessageId: '', result: 'FAILED',
        detail: String(e && e.message).slice(0, 300)
      });
      var willRetry = (ROUTE === 'client') &&
        (((deps.store.attemptsFor(m.id) || {}).failures || 0) < CLIENT_MAX_ATTEMPTS);
      deps.log('error', 'relay failed for ' + m.id +
        (willRetry ? ' — one retry on the next pass' : ' and will NOT be retried') +
        ': ' + (e && e.message));
      if (!willRetry && ROUTE === 'client') {
        deps.alert('G247 relay: CLIENT send FAILED, not retrying',
          'Item ' + verdict.itemId + ' (' + m.subject + ') could not be relayed to ' +
          recipients.join(', ') + ' after ' + CLIENT_MAX_ATTEMPTS + ' attempts. ' +
          'The client has NOT received it. Error: ' + (e && e.message));
      }
    }
  }

  if (page.newHistoryId && pageDrained) {
    deps.state.setCursor(CURSOR_KEY, page.newHistoryId);
  } else if (page.newHistoryId) {
    deps.log('info', 'cursor held at ' + cursor + ' — the pass did not drain its ' +
      'window (' + ids.length + ' seen, batch ' + MAX_BATCH +
      (page.hasMore ? ', more pages pending' : '') + '). Next pass resumes here.');
  }
  summary.pageDrained = pageDrained;
  return summary;
}

// ==========================================================================
// APPS SCRIPT WIRING — no logic below this line
// ==========================================================================

function props_() { return PropertiesService.getScriptProperties(); }

function propStore_() {
  var p = props_();
  return { get: function (k) { return p.getProperty(k); },
           set: function (k, v) { p.setProperty(k, String(v)); } };
}

function stateStore_() {
  var p = PropertiesService.getUserProperties();
  return { getCursor: function (k) { return p.getProperty(k) || ''; },
           setCursor: function (k, v) { p.setProperty(k, String(v)); } };
}

/** Gmail, as projects@group247ww.com. The only file section touching Gmail. */
function gmailService_() {
  function header(payload, name) {
    var hs = (payload && payload.headers) || [];
    var want = String(name).toLowerCase();
    var hit = [];
    for (var i = 0; i < hs.length; i++) {
      if (String(hs[i].name).toLowerCase() === want) { hit.push(hs[i].value || ''); }
    }
    return hit;
  }

  /**
   * Gmail returns `format: byte` fields in more than one shape. This is the same
   * dispatch the intake needed after every decoder failed on real mail — do not
   * "simplify" it back to a single base64 call.
   */
  function decode(data) {
    if (data === null || data === undefined || data === '') { return ''; }
    if (typeof data !== 'string') {
      try { return Utilities.newBlob(data).getDataAsString(); } catch (e) { /* fall through */ }
    }
    var s = String(data).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) { return String(data); }
    var rem = s.length % 4;
    if (rem === 2) { s += '=='; } else if (rem === 3) { s += '='; } else if (rem === 1) { s = s.slice(0, -1); }
    try { return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString(); } catch (e1) { /* next */ }
    try {
      return Utilities.newBlob(Utilities.base64Decode(
        s.replace(/-/g, '+').replace(/_/g, '/'))).getDataAsString();
    } catch (e2) { return ''; }
  }

  return {
    profile: function () { return Gmail.Users.getProfile('me').emailAddress; },
    currentHistoryId: function () { return String(Gmail.Users.getProfile('me').historyId); },

    /** Message ids that appeared since the cursor. SENT mail included. */
    historyList: function (startHistoryId) {
      // FOLLOW EVERY PAGE. Gmail's history is paginated and a page can contain
      // history records with no SENT message in it (label changes, inbound
      // mail). Reading only the first page and then holding the cursor because
      // there was "more" deadlocked the relay for 34 hours on 18-19 Sep 2026:
      // 0 seen, more pages pending, every minute, forever. labelId and
      // historyTypes make Gmail drop the noise server-side; the loop handles
      // whatever noise remains. hasMore is true only when the batch cap stopped
      // us, which is the one case the caller must hold the cursor for.
      var ids = [];
      var seen = {};
      var token = null;
      var pages = 0;
      var newest = '';
      do {
        var params = { startHistoryId: String(startHistoryId),
                       historyTypes: ['messageAdded'], labelId: 'SENT', maxResults: 500 };
        if (token) { params.pageToken = token; }
        var res = Gmail.Users.History.list('me', params);
        ((res && res.history) || []).forEach(function (h) {
          (h.messagesAdded || []).forEach(function (a) {
            var msg = a.message;
            if (!msg || !msg.id) { return; }
            var labels = msg.labelIds || [];
            // Only what THIS mailbox sent, which is where monday's automation
            // copies land. Drafts and inbound mail are not ours to relay.
            if (labels.indexOf('SENT') === -1) { return; }
            if (labels.indexOf('DRAFT') !== -1 || labels.indexOf('TRASH') !== -1) { return; }
            if (!seen[msg.id]) { seen[msg.id] = true; ids.push(msg.id); }
          });
        });
        if (res && res.historyId) { newest = String(res.historyId); }
        token = res && res.nextPageToken;
        pages++;
      } while (token && ids.length < MAX_BATCH && pages < 20);
      return {
        messageIds: ids,
        newHistoryId: newest,
        hasMore: !!token
      };
    },

    messageMeta: function (id) {
      var msg;
      try { msg = Gmail.Users.Messages.get('me', id, { format: 'full' }); }
      catch (e) { return { ok: false, id: id }; }
      var p = msg.payload || {};
      var addresses = extractAddresses(
        header(p, 'To').concat(header(p, 'Cc')).concat(header(p, 'Bcc')));

      var html = '', text = '';
      (function walk(part) {
        if (!part) { return; }
        var mime = part.mimeType || '';
        var b = part.body || {};
        if ((mime === 'text/html' || mime === 'text/plain') && !part.filename) {
          var raw = b.data;
          if (!raw && b.attachmentId) {
            try { raw = Gmail.Users.Messages.Attachments.get('me', id, b.attachmentId).data; }
            catch (e) { raw = null; }
          }
          if (raw) {
            var t = decode(raw);
            if (mime === 'text/html' && !html) { html = t; }
            else if (mime === 'text/plain' && !text) { text = t; }
          }
        }
        (part.parts || []).forEach(walk);
      })(p);

      return {
        ok: true,
        id: msg.id,
        addresses: addresses,
        subject: (header(p, 'Subject')[0] || ''),
        syncHeader: (header(p, SYNC_HEADER_NAME)[0] || ''),
        internalDate: Number(msg.internalDate || 0),
        headerMessageId: String(header(p, 'Message-ID')[0] || '').replace(/^<|>$/g, ''),
        bodyHtml: html,
        bodyText: text,
        recipientsLine: parseRecipientsLine(html, text),
        htmlOptIn: parseHtmlOptIn(html, text),
        rootMarker: parseRootMarker(html, text)
      };
    },

    /** A fresh message to the PM. No threadId: their mailbox threads it. */
    sendRaw: function (raw) {
      var res = Gmail.Users.Messages.send({
        raw: Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '')
      }, 'me');
      return String((res && res.id) || '');
    }
  };
}

/**
 * The intake's ledger, READ ONLY. Item rows map a monday item id to the Gmail
 * thread, the root Message-ID and the PM who owns it.
 */
function ledgerReader_() {
  var byItem = null;
  var byThread = null;
  function load() {
    byItem = {};
    byThread = {};
    var sh = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getSheetByName(LEDGER_SHEET);
    if (!sh) { throw new Error('ledger sheet "' + LEDGER_SHEET + '" not found'); }
    var values = sh.getDataRange().getValues();
    if (values.length < 2) { return; }
    var head = values[0];
    var col = {};
    head.forEach(function (h, i) { col[String(h)] = i; });
    for (var r = 1; r < values.length; r++) {
      var kind = String(values[r][col.kind]);

      // Participant rows, written by the intake on create and on every reply.
      // LAST ONE WINS — the newest row is the current state of the thread.
      if (kind === 'participants') {
        if (col.participants === undefined) { continue; }
        byThread[String(values[r][col.threadId] || '')] =
          String(values[r][col.participants] || '');
        continue;
      }

      if (kind !== 'item') { continue; }
      byItem[String(values[r][col.key])] = {
        mailbox: String(values[r][col.mailbox] || ''),
        threadId: String(values[r][col.threadId] || ''),
        headerMessageId: String(values[r][col.headerMessageId] || ''),
        subject: String(values[r][col.subject] || '')
      };
    }
  }
  return {
    itemThread: function (itemId) {
      if (byItem === null) { load(); }
      return byItem[String(itemId)] || null;
    },
    threadParticipants: function (threadId) {
      if (byItem === null) { load(); }
      var raw = byThread[String(threadId || '')];
      if (!raw) { return []; }
      return String(raw).split(',').map(function (a) { return a.trim().toLowerCase(); })
        .filter(function (a) { return !!a; });
    }
  };
}

/** This script's own spreadsheet. Never the intake's — see the note on state. */
function relayStore_() {
  var cache = null;
  function sheet() {
    if (!STATE_SPREADSHEET_ID) {
      throw new Error('no state spreadsheet for route "' + ROUTE + '" — ' +
        'STATE_SPREADSHEET_IDS has ids for: ' +
        Object.keys(STATE_SPREADSHEET_IDS).join(', '));
    }
    var ss = SpreadsheetApp.openById(STATE_SPREADSHEET_ID);
    var sh = ss.getSheetByName(STATE_SHEET);
    if (!sh) {
      sh = ss.insertSheet(STATE_SHEET);
      sh.getRange(1, 1, 1, STATE_HEADERS.length).setValues([STATE_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  }
  var roots = null;   // [{itemId, ts}] for every 'root-seen' row, filled with the cache
  function loaded() {
    if (cache) { return cache; }
    cache = {};
    roots = [];
    var values = sheet().getDataRange().getValues();
    var ri = STATE_HEADERS.indexOf('result');
    var ii = STATE_HEADERS.indexOf('itemId');
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][2]);
      var res = String(values[r][ri] || '');
      var a = cache[k] || { last: '', failures: 0 };
      a.last = res;
      if (res === 'FAILED') { a.failures++; }
      cache[k] = a;
      if (res === 'root-seen') {
        roots.push({ itemId: String(values[r][ii] || ''), ts: Date.parse(String(values[r][0])) || 0 });
      }
    }
    return cache;
  }
  return {
    hasRelayed: function (sourceMessageId) {
      var a = loaded()[String(sourceMessageId)];
      return !!(a && a.last);
    },

    /**
     * What has already been tried for this source message.
     * {last: 'sent'|'sending'|'FAILED'|'sent-self', failures: n} or null.
     * The retry decision in shouldRelay() is made entirely from this.
     */
    attemptsFor: function (sourceMessageId) {
      return loaded()[String(sourceMessageId)] || null;
    },

    /** Roots this deployment has seen, newest state-sheet rows included. */
    recentRoots: function () {
      loaded();
      return roots.slice();
    },

    record: function (rec) {
      var sh = sheet();
      sh.appendRow(STATE_HEADERS.map(function (h) { return rec[h] === undefined ? '' : rec[h]; }));
      if (String(rec.result) === 'root-seen') {
        loaded();
        roots.push({ itemId: String(rec.itemId || ''), ts: Date.parse(String(rec.ts)) || Date.now() });
      }
      // KEEP THE SHEET BOUNDED. Every pass reads the whole sheet, so it must not
      // grow forever. Rows only matter while their message can still be
      // re-read from history (days), so the oldest can go once there are far
      // more than that. Oldest-first: the sheet is append-ordered by ts.
      var excess = sh.getLastRow() - 1 - STATE_MAX_ROWS;
      if (excess > 0) { sh.deleteRows(2, excess); }
      var k = String(rec.sourceMessageId);
      var a = loaded()[k] || { last: '', failures: 0 };
      a.last = String(rec.result || '');
      if (a.last === 'FAILED') { a.failures++; }
      loaded()[k] = a;
    },

    /** Every client-route row, for relayHealth(). */
    allRows: function () {
      var values = sheet().getDataRange().getValues();
      var out = [];
      for (var r = 1; r < values.length; r++) {
        var row = {};
        STATE_HEADERS.forEach(function (h, i) { row[h] = values[r][i]; });
        out.push(row);
      }
      return out;
    }
  };
}

function deps_() {
  return {
    gmail: gmailService_(),
    ledger: ledgerReader_(),
    store: relayStore_(),
    state: stateStore_(),
    props: propStore_(),
    now: function () { return new Date().toISOString(); },
    nowMs: function () { return Date.now(); },
    b64: function (s) { return Utilities.base64Encode(s, Utilities.Charset.UTF_8); },
    log: function (level, msg) { console.log('[' + level + '] ' + msg); },
    alert: function (subject, body) {
      try { MailApp.sendEmail(ALERT_EMAIL, subject, body); }
      catch (e) { console.log('[error] alert could not be sent: ' + (e && e.message)); }
    }
  };
}

// ----------------------------------------------------------------- RUNNERS

/** Sends nothing. Run this first, always. */
function relayDryRun() {
  var s = runRelayPass(deps_(), { dryRun: true });
  console.log(JSON.stringify(s, null, 2));
  return s;
}

/** The real thing. */
function relayRun() {
  var s = runRelayPass(deps_(), {});
  console.log(JSON.stringify(s, null, 2));
  return s;
}

function installRelayTrigger() {
  // Only this handler's triggers — removeRelayTriggers() would take the daily
  // health check with it, and a monitor that silently disappears when you
  // reinstall the thing it monitors is worse than no monitor.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'relayRun') { ScriptApp.deleteTrigger(t); }
  });
  // CLIENT RUNS EVERY MINUTE; INTERNAL EVERY FIVE.
  //
  // A client waits on the client relay: the kick-off and every approval reach
  // them only after this pass finds the message, and at 5 minutes the gap
  // between the root email and the kick-off was the visible cost (14:03 vs
  // 14:08 on 14 Sep). The floor is the intake's own 1-minute poll plus this
  // one, so about two minutes worst case. Anything faster needs Gmail push
  // notifications and a Cloud project, which is not worth it for a poll.
  //
  // Both relays run as projects@ and share ONE Apps Script quota: 6 hours of
  // trigger runtime a day on Workspace. A quiet pass is a few seconds, so
  // 1-minute on client alone is well inside that; 1-minute on both would be
  // near the line for no client-visible benefit.
  var every = (ROUTE === 'client') ? 1 : 5;
  ScriptApp.newTrigger('relayRun').timeBased().everyMinutes(every).create();
  return 'relayRun installed at ' + every + '-minute intervals (' + ROUTE + ')';
}

/**
 * One-off: forget the cursor so the NEXT relayRun seeds at the current history
 * id and relays nothing. Use when a backlog must be skipped rather than
 * replayed (e.g. after the 18-19 Sep 2026 pagination deadlock). Run as projects@.
 */
function relayReseedCursorNow() {
  PropertiesService.getUserProperties().deleteProperty(CURSOR_KEY);
  return 'cursor cleared; next relayRun seeds at the current history id and relays nothing';
}

function removeRelayTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  return 'all triggers in this project removed';
}

function relayOn() { props_().setProperty(PROP_RELAY_MODE, 'on'); return 'relay ON (' + ROUTE + ')'; }
function relayOff() { props_().setProperty(PROP_RELAY_MODE, 'off'); return 'relay OFF (' + ROUTE + ')'; }

/**
 * Build and send real relayed copies, but addressed to ALERT_EMAIL only.
 * Everything else — routing, threading, Reply-To, dedup, state — is identical,
 * so what arrives is exactly what a client would have received. Run in this
 * mode until you have read one.
 */
function relaySelf() { props_().setProperty(PROP_RELAY_MODE, 'self'); return 'relay SELF (' + ROUTE + ') — copies go to ' + ALERT_EMAIL + ' only'; }

/**
 * Daily. Emails ALERT_EMAIL if anything client-facing is unaccounted for.
 * Install with installHealthTrigger(). Sends nothing but the alert.
 */
function relayHealth() {
  // ROUTE-GUARDED, and it must be.
  //
  // The check looks for marker messages with no state row and calls them lost.
  // On the INTERNAL deployment that is EVERY client message by definition —
  // internal never relays them and never records them — so an unguarded check
  // installed here would email an alert about every healthy client send. An
  // alert channel that cries wolf daily is worse than no alert at all, because
  // the real one arrives into a folder nobody opens.
  if (ROUTE !== 'client') {
    console.log('relayHealth is a CLIENT-route check and does nothing on the ' +
      ROUTE + ' deployment. Remove this trigger here; install it on CLIENT.');
    return { ok: true, skipped: 'not-the-client-route' };
  }

  var store = relayStore_();
  var nowMs = Date.now();

  // Every client automation this mailbox has sent recently, found by the marker
  // rather than by subject. If the relay is dead these are exactly the messages
  // with no state row.
  var markerMsgs = [];
  try {
    var res = Gmail.Users.Messages.list('me', {
      q: 'in:sent to:' + CLIENT_ROUTE_MARKER + ' newer_than:2d', maxResults: 100
    });
    ((res && res.messages) || []).forEach(function (m) {
      try {
        var full = Gmail.Users.Messages.get('me', m.id, { format: 'metadata', metadataHeaders: ['Date'] });
        markerMsgs.push({ id: m.id, ts: Number(full.internalDate || 0) });
      } catch (e) { /* skip one unreadable message rather than fail the check */ }
    });
  } catch (e) {
    // A search failure must not read as "all clear".
    MailApp.sendEmail(ALERT_EMAIL, 'G247 relay health: CHECK COULD NOT RUN',
      'relayHealth() could not search the mailbox: ' + (e && e.message) +
      '\n\nThe client relay is UNMONITORED until this is fixed.');
    throw e;
  }

  var h = healthCheck(store.allRows(), markerMsgs, nowMs);
  var body = healthMessage(h);
  console.log(body);
  if (!h.ok) {
    MailApp.sendEmail(ALERT_EMAIL, 'G247 relay: client mail unaccounted for', body);
  }
  return h;
}

function installHealthTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'relayHealth') { ScriptApp.deleteTrigger(t); }
  });
  if (ROUTE !== 'client') {
    return 'NOT INSTALLED — relayHealth only makes sense on the CLIENT ' +
      'deployment. Any existing health trigger in this project has been removed.';
  }
  ScriptApp.newTrigger('relayHealth').timeBased().everyDays(1).atHour(8).create();
  return 'relayHealth installed daily at ~08:00';
}

/** Scopes, mailbox, ledger access, state sheet, mode. Writes nothing. */
function relayPreflight() {
  var out = { build: BUILD, route: ROUTE, ok: true, checks: [] };
  function ck(name, fn) {
    try { out.checks.push({ name: name, result: String(fn()) }); }
    catch (e) { out.ok = false; out.checks.push({ name: name, error: String(e && e.message) }); }
  }
  ck('build', function () { return BUILD; });
  ck('kick-off rooting supported', function () {
    return (typeof parseRootMarker === 'function')
      ? 'yes — holds for a marked kick-off, suppresses the root'
      : 'NO — paste the current Relay file';
  });
  ck('gmail profile', function () { return gmailService_().profile(); });
  ck('mailbox is projects@', function () {
    var m = gmailService_().profile().toLowerCase();
    if (m !== EXPECTED_MAILBOX.toLowerCase()) {
      throw new Error('running as ' + m + ' — this script must RUN AS ' + EXPECTED_MAILBOX +
        '. Owning or sharing the project is not enough: sign in as that account to ' +
        'authorise it and to install the trigger.');
    }
    return 'yes';
  });
  ck('ledger readable', function () {
    return SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getName();
  });
  ck('items with a Gmail thread', function () {
    var sh = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getSheetByName(LEDGER_SHEET);
    var v = sh.getDataRange().getValues();
    var n = 0;
    for (var r = 1; r < v.length; r++) { if (String(v[r][0]) === 'item') { n++; } }
    return n + ' items are syncable; anything older than the bridge is not';
  });
  ck('state spreadsheet', function () {
    if (!STATE_SPREADSHEET_ID) {
      throw new Error('no state spreadsheet for route "' + ROUTE + '"');
    }
    return SpreadsheetApp.openById(STATE_SPREADSHEET_ID).getName();
  });
  ck('relay mode', function () { return props_().getProperty(PROP_RELAY_MODE) || 'off (unset)'; });
  ck('cursor', function () {
    // THE CURSOR IS PER-GOOGLE-ACCOUNT (UserProperties), and the pass always
    // runs as projects@. Read by anyone else it reports '(unseeded)' for their
    // own empty store, which reads as "the relay has lost its place" and is
    // not true. Say so rather than print a number that means nothing.
    var v = PropertiesService.getUserProperties().getProperty(CURSOR_KEY);
    var me = '';
    try { me = String(gmailService_().profile() || '').toLowerCase(); } catch (e) { me = ''; }
    if (me !== EXPECTED_MAILBOX.toLowerCase()) {
      return '(not readable as ' + (me || 'this account') + ' — the cursor belongs to ' +
        EXPECTED_MAILBOX + '. Sign in as that account to see it.)';
    }
    return v || '(unseeded)';
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}