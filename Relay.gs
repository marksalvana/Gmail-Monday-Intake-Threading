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
var ROUTE = 'internal';

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
 * Create one per deployment and paste its id here.
 */
var STATE_SPREADSHEET_ID = '';

var STATE_SHEET = 'relayed';
var STATE_HEADERS = ['ts', 'route', 'sourceMessageId', 'itemId', 'toMailbox',
  'threadId', 'subject', 'relayedMessageId', 'result', 'detail'];

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

/** Header the intake already drops on, so a relayed copy is never re-ingested. */
var SYNC_HEADER_NAME = 'X-G247-Sync';
var SYNC_HEADER_VALUE = 'monday-relay';

/** Runaway brake. Same shape as the outbound bridge's. */
var RELAY_MAX_PER_HOUR = 40;
var RELAY_WINDOW_MS = 60 * 60 * 1000;
var PROP_RELAY_RATE = 'G247_RELAY_RATE';

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
  addrs.forEach(function (a) {
    if (/pulse-\d+@[a-z0-9.\-]*monday\.com/i.test(a)) { pulses++; }
    else if (!isInternalAddress(a)) { external++; }
  });
  if (!pulses) { return ''; }
  return external ? 'client' : 'internal';
}

// ================================================================ FORMATTING

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function replySubject(subject) {
  var s = String(subject || '').trim() || '(no subject)';
  return /^re:\s*/i.test(s) ? s : 'Re: ' + s;
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

/** A banner saying where this came from, then monday's own message. PURE. */
function relayBody(a) {
  var head = '<div style="color:#666;font-size:12px;border-left:3px solid #ccc;padding-left:8px;margin-bottom:12px">' +
    'monday automation &middot; item ' + escapeHtml(String(a.itemId || '')) +
    '<br><b>' + escapeHtml(a.originalSubject || '(no subject)') + '</b>' +
    (a.sentTo ? '<br>sent to ' + escapeHtml(a.sentTo) : '') +
    '</div>';
  return head + (a.html || '<pre style="white-space:pre-wrap">' + escapeHtml(a.text || '') + '</pre>');
}

// =============================================================== RATE LIMIT

function relayRateGate(store, nowMs, limit, windowMs) {
  var raw = store.get(PROP_RELAY_RATE);
  var st;
  try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
  if (!st || typeof st.windowStart !== 'number' || (nowMs - st.windowStart) >= windowMs) {
    st = { windowStart: nowMs, count: 0 };
  }
  if (st.count >= limit) { return { allow: false, count: st.count, commit: function () {} }; }
  return {
    allow: true,
    count: st.count,
    commit: function () { st.count++; st.lastAt = nowMs; store.set(PROP_RELAY_RATE, JSON.stringify(st)); }
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

  if (ctx.alreadyRelayed) { return { relay: false, reason: 'already-relayed' }; }

  var anchor = ctx.anchorFor(ids[0]);
  if (!anchor || !anchor.threadId || !anchor.headerMessageId || !anchor.mailbox) {
    // Expected and common: only projects the intake created from a labelled
    // email have a Gmail thread. Everything older has nowhere to go.
    return { relay: false, reason: 'item-has-no-gmail-thread', itemId: ids[0] };
  }

  return { relay: true, reason: 'ok', itemId: ids[0], anchor: anchor };
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
                  failed: 0, seeded: false, reasons: {} };

  var mode = String(deps.props.get(PROP_RELAY_MODE) || 'off').toLowerCase();
  summary.mode = mode;
  if (mode !== 'on') { return summary; }

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

  for (var i = 0; i < ids.length && i < MAX_BATCH; i++) {
    var m = deps.gmail.messageMeta(ids[i]);
    if (!m || !m.ok) { note('fetch-failed'); continue; }

    var verdict = shouldRelay(m, {
      route: ROUTE,
      alreadyRelayed: deps.store.hasRelayed(m.id),
      anchorFor: function (itemId) { return deps.ledger.itemThread(itemId); }
    });

    if (!verdict.relay) { note(verdict.reason); continue; }

    var gate = relayRateGate(deps.props, deps.nowMs(), RELAY_MAX_PER_HOUR, RELAY_WINDOW_MS);
    if (!gate.allow) {
      deps.log('warn', 'relay hit ' + RELAY_MAX_PER_HOUR + '/hour cap; stopping this pass');
      break;   // cursor is not advanced past it — retried next window
    }

    var raw = buildRelayMime({
      to: verdict.anchor.mailbox,
      threadSubject: verdict.anchor.subject,
      headerMessageId: verdict.anchor.headerMessageId,
      itemId: verdict.itemId,
      route: ROUTE,
      sourceMessageId: m.id,
      originalSubject: m.subject,
      sentTo: (m.addresses || []).filter(function (a) {
        return !/pulse-\d+@/i.test(a);
      }).join(', '),
      html: m.bodyHtml,
      text: m.bodyText
    }, deps.b64);

    if (opts.dryRun) {
      deps.log('info', 'DRY RUN would relay "' + m.subject + '" (item ' + verdict.itemId +
        ') into ' + verdict.anchor.mailbox + ' thread ' + verdict.anchor.threadId);
      summary.relayed++;
      continue;
    }

    // RECORD BEFORE SEND. A duplicate email cannot be recalled; a missing one
    // can be re-sent by hand. Same rule as the outbound bridge.
    deps.store.record({
      ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: verdict.itemId,
      toMailbox: verdict.anchor.mailbox, threadId: verdict.anchor.threadId,
      subject: m.subject, relayedMessageId: '', result: 'sending', detail: ''
    });

    try {
      var sent = deps.gmail.sendRaw(raw);
      gate.commit();
      summary.relayed++;
      deps.store.record({
        ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: verdict.itemId,
        toMailbox: verdict.anchor.mailbox, threadId: verdict.anchor.threadId,
        subject: m.subject, relayedMessageId: sent, result: 'sent', detail: ''
      });
    } catch (e) {
      summary.failed++;
      deps.store.record({
        ts: deps.now(), route: ROUTE, sourceMessageId: m.id, itemId: verdict.itemId,
        toMailbox: verdict.anchor.mailbox, threadId: verdict.anchor.threadId,
        subject: m.subject, relayedMessageId: '', result: 'FAILED',
        detail: String(e && e.message).slice(0, 300)
      });
      deps.log('error', 'relay failed for ' + m.id + ' and will NOT be retried: ' + (e && e.message));
    }
  }

  if (page.newHistoryId) { deps.state.setCursor(CURSOR_KEY, page.newHistoryId); }
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
      var res = Gmail.Users.History.list('me', { startHistoryId: String(startHistoryId) });
      var ids = [];
      var seen = {};
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
      return { messageIds: ids, newHistoryId: res && res.historyId ? String(res.historyId) : '' };
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
        bodyHtml: html,
        bodyText: text
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
  function load() {
    byItem = {};
    var sh = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getSheetByName(LEDGER_SHEET);
    if (!sh) { throw new Error('ledger sheet "' + LEDGER_SHEET + '" not found'); }
    var values = sh.getDataRange().getValues();
    if (values.length < 2) { return; }
    var head = values[0];
    var col = {};
    head.forEach(function (h, i) { col[String(h)] = i; });
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][col.kind]) !== 'item') { continue; }
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
    }
  };
}

/** This script's own spreadsheet. Never the intake's — see the note on state. */
function relayStore_() {
  var cache = null;
  function sheet() {
    if (!STATE_SPREADSHEET_ID) {
      throw new Error('STATE_SPREADSHEET_ID is not set — create a spreadsheet for this script and paste its id');
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
  function loaded() {
    if (cache) { return cache; }
    cache = {};
    var values = sheet().getDataRange().getValues();
    for (var r = 1; r < values.length; r++) { cache[String(values[r][2])] = true; }
    return cache;
  }
  return {
    hasRelayed: function (sourceMessageId) { return !!loaded()[String(sourceMessageId)]; },
    record: function (rec) {
      var sh = sheet();
      sh.appendRow(STATE_HEADERS.map(function (h) { return rec[h] === undefined ? '' : rec[h]; }));
      loaded()[String(rec.sourceMessageId)] = true;
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
    log: function (level, msg) { console.log('[' + level + '] ' + msg); }
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
  removeRelayTriggers();
  ScriptApp.newTrigger('relayRun').timeBased().everyMinutes(5).create();
  return 'relayRun installed at 5-minute intervals';
}

function removeRelayTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  return 'all triggers in this project removed';
}

function relayOn() { props_().setProperty(PROP_RELAY_MODE, 'on'); return 'relay ON (' + ROUTE + ')'; }
function relayOff() { props_().setProperty(PROP_RELAY_MODE, 'off'); return 'relay OFF (' + ROUTE + ')'; }

/** Scopes, mailbox, ledger access, state sheet, mode. Writes nothing. */
function relayPreflight() {
  var out = { route: ROUTE, ok: true, checks: [] };
  function ck(name, fn) {
    try { out.checks.push({ name: name, result: String(fn()) }); }
    catch (e) { out.ok = false; out.checks.push({ name: name, error: String(e && e.message) }); }
  }
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
    if (!STATE_SPREADSHEET_ID) { throw new Error('STATE_SPREADSHEET_ID is not set'); }
    return SpreadsheetApp.openById(STATE_SPREADSHEET_ID).getName();
  });
  ck('relay mode', function () { return props_().getProperty(PROP_RELAY_MODE) || 'off (unset)'; });
  ck('cursor', function () {
    return PropertiesService.getUserProperties().getProperty(CURSOR_KEY) || '(unseeded)';
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}
