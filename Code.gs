/**
 * G247 Gmail <-> monday bridge — GENERATED FILE, DO NOT EDIT HERE.
 *
 * Built from src/*.gs by tools/build.js.
 * Source commit: 978f0b5
 *
 * Editing this file in the Apps Script editor works, but the next build
 * overwrites it. Change the module in the repo and rebuild instead.
 *
 * Contents, in order:
 *   00_Config.gs
 *   10_Extractor.gs
 *   20_Classifier.gs
 *   30_ColumnValues.gs
 *   35_UpdateBody.gs
 *   40_Store.gs
 *   45_RunLog.gs
 *   50_SheetAdapter.gs
 *   55_Migration.gs
 *   60_Intake.gs
 *   70_GmailService.gs
 *   80_MondayClient.gs
 *   85_Writer.gs
 *   90_Entrypoints.gs
 *   95_WebApp.gs
 *   99_Verify.gs
 */

// ==========================================================================
// 00_Config.gs
// ==========================================================================

/**
 * G247 Gmail <-> monday — configuration.
 *
 * Every ID here was read from the live monday API on 2026-08-11, not assumed.
 * See claude/field-mapping-2026-08-11.md in the project for provenance.
 *
 * This file is plain JavaScript with no Apps Script globals so the test harness
 * can load it under Node unchanged. Nothing here calls a Google service.
 */

/** Gmail history batch cap — matches the Make implementation. */
var MAX_BATCH = 25;

/**
 * The ledger + run-log spreadsheet. Owned by msalvana@group247ww.com, which is
 * also the account the central Web App is deployed as.
 * https://docs.google.com/spreadsheets/d/1HEx6QQaTyOazuOEX0K0RdfxRzO843gouL00zHCIRldw/
 */
var LEDGER_SPREADSHEET_ID = '1HEx6QQaTyOazuOEX0K0RdfxRzO843gouL00zHCIRldw';

/**
 * Every per-user script calls the central Web App rather than monday directly,
 * so the monday API token lives in exactly one place and the other four people
 * never hold it. Set after deploying 90_Entrypoints.gs as a Web App.
 * Stored in Script Properties, not here — it is an environment value, not code.
 */
var PROP_WEBAPP_URL = 'G247_WEBAPP_URL';
var PROP_WEBAPP_SECRET = 'G247_WEBAPP_SECRET';
var PROP_MONDAY_TOKEN = 'G247_MONDAY_TOKEN';

/**
 * Mailboxes in the pipeline. Adding one is a single edit here plus that person
 * installing the stub script; unlike Make there is no shared budget to consume,
 * so a sixth mailbox brings its own quota rather than eating someone else's.
 */
var MAILBOX_TO_MONDAY_USER = {
  'msalvana@group247ww.com': 78417174,   // Mark Salvana
  'dnoble@group247ww.com': 37824531,     // David Noble
  'mdelarosa@group247ww.com': 77510926,  // Miguel Dela Rosa
  'sgow@group247ww.com': 40329884,       // Stephen Gow
  'idemetriou@group247ww.com': 69705587  // Ismini Demetriou
};

/**
 * THE LOOP-GUARD IDENTITY.
 *
 * Whichever monday account the integration's API token belongs to. The bridge
 * must ignore updates authored by this user, or it treats its own writes as
 * human activity and echoes them back to Gmail forever.
 *
 * WARNING: the Make pipeline ran as 37824531 (David Noble) and its bridge guard
 * is still hardcoded to that ID. During the parallel run BOTH identities are
 * writing, so the guard has to accept both. Do not drop the legacy entry until
 * the Make scenarios are retired.
 */
var INTEGRATION_USER_IDS = [
  78417174,  // Mark Salvana — Apps Script token owner (temporary)
  37824531   // David Noble  — legacy Make token owner; remove after Make retires
];

/** Addresses that are machines talking about the machinery. Never ingest. */
var AUTOMATION_SENDERS = [
  'noreply@us1.make.com',
  'make-events@make.com',
  'notifications@monday.com'
];

/** Header the outbound bridge stamps on everything it sends. */
var SYNC_HEADER_NAME = 'X-G247-Sync';

/**
 * Project-board column IDs. Identical across 18424992348 and 18401123784.
 * Anything absent on a given board is skipped, not written — see
 * buildColumnValues(). That is what lets any of the 47 boards be a target
 * with no per-board setup.
 */
var COLUMNS = {
  g247pm: 'people',                  // people    — who received and labelled it
  clientEmail: 'email_mm3wcj3h',     // email     — sender's address
  clientContact: 'connect_boards5',  // board_relation -> Contacts 4152280281
  gmailRootMessageId: 'text_mm5xb5tp',
  gmailThreadId: 'text_mm5xdgfa',
  lastGmailSync: 'date_mm5x5x1b',
  gmailSyncMessage: 'long_text_mm5xcds9',
  gmailSyncStatus: 'color_mm5x50bt'
};

/** Contacts board behind the C. Contact relation. Match on the `email` column. */
var CONTACTS_BOARD_ID = '4152280281';
var CONTACTS_EMAIL_COLUMN = 'email';

/**
 * Do NOT auto-create contacts. An unmatched sender leaves the relation empty and
 * only C. Email is written, so the 123-row Contacts board stays curated rather
 * than accumulating mailing lists, one-off senders and typo'd addresses.
 */
var AUTO_CREATE_CONTACTS = false;

/** Dead-letter board — a human-visible queue for anything monday rejects. */
var DEADLETTER_BOARD_ID = '18425466374';
var DEADLETTER_COLUMNS = {
  gmailMessageId: 'text_mm5zef3n',
  gmailThreadId: 'text_mm5znf6w',
  error: 'long_text_mm5zhztf',
  mailbox: 'text_mm5z6qw0',
  targetBoard: 'text_mm5zyqe',
  failedAt: 'date_mm5zde3v'
};

/** The one board whose group is known; everything else lands in the default. */
var KNOWN_BOARD_ID = '18424992348';
var KNOWN_BOARD_GROUP = 'topics';

/**
 * Boards that must never be a label target.
 *
 * 19 of G247's 47 active boards are auto-generated subitem boards named
 * "Subitems of X". They are returned by the `boards` query like any other, so a
 * label named "Subitems of PageProof" would match one and create a project item
 * on a subitem board — wrong, and confusing to unpick afterwards.
 *
 * `board_kind` does NOT distinguish them (checked against the live API on
 * 11 Aug: both a real board and its subitem board report "share"), so the name
 * prefix is the only reliable signal.
 */
function isProjectBoard(boardName) {
  var n = String(boardName || '').trim();
  if (!n) { return false; }
  if (n.toLowerCase().indexOf('subitems of ') === 0) { return false; }
  return true;
}

/**
 * Gmail reports a nested label by its FULL PATH — a label filed under
 * "Monday Projects" comes back as "Monday Projects/iNova AU NEW", which matches
 * no board and silently creates nothing.
 *
 * When true, the classifier also tries the last path segment, so nesting labels
 * into a folder works. Matching stays EXACT on that segment: no fuzzy matching,
 * ever. When false, only the full label name is considered.
 */
var MATCH_NESTED_LABEL_LEAF = true;

/** ['Monday Projects/iNova AU NEW'] -> ['monday projects/inova au new', 'inova au new'] */
function labelMatchKeys(labelName) {
  var full = String(labelName || '').trim().toLowerCase();
  if (!full) { return []; }
  var keys = [full];
  if (MATCH_NESTED_LABEL_LEAF && full.indexOf('/') !== -1) {
    var leaf = full.split('/').pop().trim();
    if (leaf && leaf !== full) { keys.push(leaf); }
  }
  return keys;
}

/**
 * Gmail returns message bodies as UNPADDED base64url. Apps Script's decoder is
 * strict about length and throws "Could not decode string." on real messages.
 *
 * PADS ONLY — the alphabet is left alone. An earlier version also converted
 * `-`/`_` to `+`/`/` before calling base64DecodeWebSafe, which expects the
 * web-safe alphabet: that handed the web-safe decoder standard-alphabet input
 * and broke exactly the messages the padding fix was meant to save.
 */
function padBase64(data) {
  var s = String(data || '').replace(/\s+/g, '');
  if (!s) { return ''; }
  var rem = s.length % 4;
  if (rem === 2) { s += '=='; }
  else if (rem === 3) { s += '='; }
  else if (rem === 1) { s = s.slice(0, -1); }  // a stray char cannot be valid
  return s;
}

/** base64url -> standard alphabet, for the non-web-safe decoder. */
function toStandardBase64(data) {
  return padBase64(String(data || '').replace(/-/g, '+').replace(/_/g, '/'));
}

/** Back-compat alias; pads without touching the alphabet. */
function normalizeBase64Url(data) { return padBase64(data); }


/**
 * Does this string consist ONLY of base64 characters (either alphabet)?
 *
 * Used to tell an ENCODED body from one that is already plain text. Apps Script's
 * advanced services do not hand back a consistent shape for the Gmail API's
 * `format: byte` fields, and feeding a decoder something that was never base64
 * throws "Could not decode string." with no clue as to why.
 */
function looksLikeBase64(s) {
  var t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, '');
  if (!t) { return false; }
  return /^[A-Za-z0-9+/_=-]+$/.test(t);
}

/** Node test harness needs these; Apps Script ignores it. */

// ==========================================================================
// 10_Extractor.gs
// ==========================================================================

/**
 * Gmail history extractor — pure function, no Google services touched.
 *
 * Ported verbatim in behaviour from Make scenario 4860070 module 4 (v7.1).
 * The reply heuristic below is the fix for two separate live bugs and must not
 * be "simplified" without re-reading why it exists.
 *
 * CHANGE FROM MAKE: each item now carries `tid` (the thread id) as well as `mid`.
 * The thread id is already present in the history stub and costs nothing to
 * carry, and having it lets the caller check the thread anchor BEFORE fetching
 * the message — one fewer Gmail round trip on the common case of a reply in a
 * thread we do not track.
 */

function isUserLabel(id) {
  return typeof id === 'string' && id.indexOf('Label_') === 0;
}

/**
 * @param {Object|string} raw   Gmail users.history.list response.
 * @param {string} startHistoryId  Cursor the request was made from.
 * @return {{items: Array<{mid:string,tid:string,hid:string}>, count:number,
 *           idleHistoryId:string, newHistoryId:string, hasNextPage:boolean,
 *           capped:boolean, hasMore:boolean, rawHistoryCount:number,
 *           recordsConsumed:number, eventsScanned:number}}
 */
function extractCandidates(raw, startHistoryId) {
  var obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (e) { obj = {}; }
  }

  var hist = (obj && obj.history) || [];
  var start = startHistoryId ? String(startHistoryId) : '';
  var newHistoryId = obj && obj.historyId ? String(obj.historyId) : '';
  var hasNextPage = !!(obj && obj.nextPageToken);

  var items = [];
  var seen = {};
  var lastConsumedHistoryId = '';
  var capped = false;
  var recordsConsumed = 0;
  var eventsScanned = 0;

  for (var i = 0; i < hist.length; i++) {
    var h = hist[i];
    var hid = h && h.id ? String(h.id) : '';
    var candidates = [];

    // --- labelsAdded: someone applied a label to an existing message ---------
    var la = h.labelsAdded || [];
    for (var j = 0; j < la.length; j++) {
      eventsScanned++;
      var lm = la[j].message;
      if (!lm || !lm.id) { continue; }
      var added = la[j].labelIds || [];
      var lhit = false;
      for (var k = 0; k < added.length; k++) {
        if (isUserLabel(added[k])) { lhit = true; break; }
      }
      if (lhit) { candidates.push({ mid: lm.id, tid: lm.threadId || '' }); }
    }

    // --- messagesAdded: a new message arrived (or was sent) -----------------
    var ma = h.messagesAdded || [];
    for (var m2 = 0; m2 < ma.length; m2++) {
      eventsScanned++;
      var msg = ma[m2].message;
      if (!msg || !msg.id) { continue; }
      var onMsg = msg.labelIds || [];
      var hit = false;
      for (var n = 0; n < onMsg.length; n++) {
        if (isUserLabel(onMsg[n])) { hit = true; break; }
      }

      // v7.1: REPLIES, IN BOTH DIRECTIONS.
      // Gmail does not put a thread's user label on any new message in that
      // thread — not on the SENT copy of what you write (19fda19176144e4a had
      // labelIds ["SENT"] alone) and not on what the client sends back
      // (19fda1cc0ceee0de had ["IMPORTANT","INBOX"] alone). Both were invisible
      // here and never reached the thread probe. Each was reported as a bug.
      //
      // threadId equals the id of the FIRST message in the thread, so
      // threadId !== id means "this is a reply". It comes free in the stub.
      //
      // A reply in a thread with no anchor still classifies unmatched-no-board
      // and creates nothing, so exact-name label matching is untouched.
      // Non-replies without a label are still ignored, which keeps newsletters
      // and one-off notifications out of the pipeline.
      //
      // DRAFT must NOT pass: messagesAdded fires for drafts, and an unsent draft
      // would append to the monday item prematurely. TRASH/SPAM likewise.
      if (!hit && msg.threadId && String(msg.threadId) !== String(msg.id) &&
          onMsg.indexOf('DRAFT') === -1 &&
          onMsg.indexOf('TRASH') === -1 &&
          onMsg.indexOf('SPAM') === -1) {
        hit = true;
      }

      if (hit) { candidates.push({ mid: msg.id, tid: msg.threadId || '' }); }
    }

    var fresh = [];
    for (var f = 0; f < candidates.length; f++) {
      if (!seen[candidates[f].mid]) { fresh.push(candidates[f]); }
    }

    // Stop on a record boundary, never mid-record, so the cursor stays coherent.
    if (items.length > 0 && (items.length + fresh.length) > MAX_BATCH) {
      capped = true;
      break;
    }

    for (var g = 0; g < fresh.length; g++) {
      seen[fresh[g].mid] = true;
      items.push({
        mid: fresh[g].mid,
        tid: fresh[g].tid,
        hid: hid || newHistoryId || start
      });
    }
    recordsConsumed++;
    if (hid) { lastConsumedHistoryId = hid; }
  }

  // Idle-advance target: only used when count === 0. If we stopped early we must
  // NOT jump to the newest historyId, or everything after the cap is lost.
  var idleHistoryId = start;
  if (capped || hasNextPage) {
    if (lastConsumedHistoryId) { idleHistoryId = lastConsumedHistoryId; }
  } else if (newHistoryId) {
    idleHistoryId = newHistoryId;
  }

  return {
    items: items,
    count: items.length,
    idleHistoryId: idleHistoryId,
    newHistoryId: newHistoryId,
    hasNextPage: hasNextPage,
    capped: capped,
    hasMore: !!(capped || hasNextPage),
    rawHistoryCount: hist.length,
    recordsConsumed: recordsConsumed,
    eventsScanned: eventsScanned
  };
}

// ==========================================================================
// 20_Classifier.gs
// ==========================================================================

/**
 * Message classifier — pure function, no Google or monday services touched.
 *
 * Ported from Make scenario 4860070 module 11 (v11). The PRECEDENCE ORDER is the
 * whole design; each rung exists because something went wrong without it:
 *
 *   1. !fetchOk            — nothing usable came back; never guess
 *   2. automationSender    — machine mail must never create or append
 *   3. syncOrigin          — our own outbound; ingesting it loops forever
 *   4. bypassMatch         — addressed straight at a monday item
 *   5. alreadyProcessed    — message-level dedup
 *   6. threadKnown         — thread-level: append instead of creating
 *   7. no board match      — a label that matches nothing creates nothing
 *   8. >1 board match      — ambiguous, refuse rather than guess
 *   9. create
 *
 * Rungs 5 and 6 sit ABOVE the board checks deliberately (v7). In v6 the no-board
 * check ran first, so a reply carrying no user label — which is every reply — fell
 * into `unmatched-no-board` and never reached the thread test. That is the bug
 * that made client replies invisible.
 *
 * CHANGE FROM MAKE — dedup key. Make keyed `alreadyProcessed` on the Gmail message
 * id, which is per-mailbox: the same client email in two inboxes has two different
 * ids, so with five mailboxes both would pass dedup and create two items for one
 * email. The caller must now resolve `alreadyProcessed` from the RFC 2822
 * Message-ID header, which is identical in every mailbox that received it.
 */

/**
 * @param {Object} input
 * @param {boolean} input.fetchOk
 * @param {string}  input.gmailMessageId   Gmail id (per-mailbox; logging only)
 * @param {string}  input.headerMessageId  RFC 2822 Message-ID (the dedup key)
 * @param {string}  input.threadId
 * @param {string}  input.fromHeader
 * @param {string}  input.to
 * @param {string}  input.cc
 * @param {string}  input.subject
 * @param {string}  input.syncOrigin       X-G247-Sync header value, if any
 * @param {string}  input.labelIdsCsv      Comma-joined label ids on the message
 * @param {Object}  input.labelMap         {labelId: name} all labels
 * @param {Object}  input.userLabelMap     {labelId: name} user-created only
 * @param {Object}  input.boardNameMap     {lowercased board name: {id, name}}
 * @param {boolean} input.alreadyProcessed Ledger holds this headerMessageId
 * @param {boolean} input.threadKnown      Ledger holds t:<threadId>
 * @param {string}  input.threadAnchorItemId  monday item id when threadKnown
 * @return {{classification:string, detail:string, labelNames:string,
 *           targetBoardId:string, targetBoardName:string,
 *           targetGroupId:(string|null), itemName:string,
 *           anchorItemId:string}}
 */
function classifyMessage(input) {
  input = input || {};

  var cc = input.cc || '';
  var to = input.to || '';
  var labelIdsCsv = input.labelIdsCsv || '';
  var labelMap = input.labelMap || {};
  var userLabelMap = input.userLabelMap || {};
  var boardNameMap = input.boardNameMap || {};
  var subject = input.subject || '';
  var messageIdIn = input.gmailMessageId || '';
  var threadIdIn = input.threadId || '';
  var anchorItemId = input.threadAnchorItemId || '';

  var alreadyProcessed = (input.alreadyProcessed === true || input.alreadyProcessed === 'true');
  var threadKnown = (input.threadKnown === true || input.threadKnown === 'true');
  var fetchOk = (input.fetchOk === true || input.fetchOk === 'true');

  // v10 LOOP GUARD. Set by the monday->Gmail bridge on everything it sends.
  var syncOrigin = String(input.syncOrigin || '').trim();

  // v11 AUTOMATION-SENDER EXCLUSION. These addresses are machines talking about
  // the machinery, not project correspondence. Make's error mail alone was dozens
  // of messages a day, and it threads heavily — so the moment one of those threads
  // acquired an anchor it would pile every future error notification onto a
  // client's project item. It also damps a feedback loop: an error sends mail, the
  // mail triggers a run, a failing run sends more mail.
  var fromHeader = String(input.fromHeader || '').toLowerCase();
  var automationSender = '';
  for (var ai = 0; ai < AUTOMATION_SENDERS.length; ai++) {
    if (fromHeader.indexOf(AUTOMATION_SENDERS[ai]) !== -1) {
      automationSender = AUTOMATION_SENDERS[ai];
      break;
    }
  }

  // Mail addressed straight at a monday item's own ingest address.
  var bypassRe = /pulse-(\d+)@g247ww\.us\.monday\.com/i;
  var bypassMatch = (to + ' ' + cc).match(bypassRe);

  var labelIds = labelIdsCsv ? String(labelIdsCsv).split(',') : [];
  var labelNames = labelIds.map(function (id) { return labelMap[id] || id; });

  var candidateLabels = labelIds
    .filter(function (id) { return Object.prototype.hasOwnProperty.call(userLabelMap, id); })
    .map(function (id) { return userLabelMap[id]; });

  // EXACT NAME EQUALITY ONLY — case-insensitive and trimmed, nothing else.
  // A near-miss label must create nothing. No fuzzy matching, ever.
  //
  // The one extension: a NESTED label. Gmail reports "Monday Projects/iNova AU
  // NEW" by its full path, which matches no board, so labels filed into a folder
  // would silently do nothing. labelMatchKeys() also offers the last path
  // segment — still an exact match on that segment, just not on the folder
  // prefix. Toggle with MATCH_NESTED_LABEL_LEAF.
  var boardMatches = [];
  candidateLabels.forEach(function (labelName) {
    var keys = labelMatchKeys(labelName);
    for (var ki = 0; ki < keys.length; ki++) {
      if (boardNameMap[keys[ki]]) {
        boardMatches.push({
          label: labelName,
          boardId: boardNameMap[keys[ki]].id,
          boardName: boardNameMap[keys[ki]].name
        });
        break;   // first key wins: full path before leaf
      }
    }
  });

  var uniqueBoardMatches = [];
  var seenBoardIds = {};
  boardMatches.forEach(function (m) {
    if (!seenBoardIds[m.boardId]) {
      seenBoardIds[m.boardId] = true;
      uniqueBoardMatches.push(m);
    }
  });

  var classification = 'unmatched';
  var detail = '';
  var targetBoardId = '';
  var targetBoardName = '';
  var targetGroupId = null;
  var itemName = '';

  if (!fetchOk) {
    classification = 'skipped-fetch-failed';
    detail = 'message fetch returned no usable payload';

  } else if (automationSender) {
    classification = 'skipped-automation-sender';
    detail = 'from ' + automationSender + '; automation notification, not project correspondence';

  } else if (syncOrigin) {
    classification = 'skipped-monday-outbound';
    detail = SYNC_HEADER_NAME + '=' + syncOrigin +
             '; written by the monday->gmail bridge, not re-ingested (loop guard)';

  } else if (bypassMatch) {
    classification = 'bypass-monday-intake';
    detail = 'itemId=' + bypassMatch[1];

  } else if (alreadyProcessed) {
    classification = 'skipped-already-processed';
    if (uniqueBoardMatches.length === 1) {
      targetBoardId = uniqueBoardMatches[0].boardId;
      targetBoardName = uniqueBoardMatches[0].boardName;
    }
    detail = 'Message-ID already in ledger' +
             (targetBoardName ? ' ; would have targeted ' + targetBoardName : '');

  } else if (threadKnown) {
    classification = 'append-to-existing-item';
    if (uniqueBoardMatches.length === 1) {
      targetBoardId = uniqueBoardMatches[0].boardId;
      targetBoardName = uniqueBoardMatches[0].boardName;
    }
    detail = 'thread ' + threadIdIn +
             ' already has a monday item; appending as an update instead of creating' +
             (targetBoardName ? '; board=' + targetBoardName
                              : '; no board label on this message (outbound or unlabelled reply)');

  } else if (uniqueBoardMatches.length === 0) {
    classification = 'unmatched-no-board';
    detail = candidateLabels.length
      ? ('labels=' + candidateLabels.join('|') + ' matched no monday board by name')
      : 'no user-created label on this message';

  } else if (uniqueBoardMatches.length > 1) {
    classification = 'skipped-ambiguous-multi-board';
    detail = 'multiple labels matched different boards: ' +
             uniqueBoardMatches.map(function (m) { return m.label + '->' + m.boardName; }).join(', ');

  } else {
    classification = 'create-matched-board';
    targetBoardId = uniqueBoardMatches[0].boardId;
    targetBoardName = uniqueBoardMatches[0].boardName;
    targetGroupId = (targetBoardId === KNOWN_BOARD_ID) ? KNOWN_BOARD_GROUP : null;

    // monday rejects an empty item_name with InvalidItemNameException, which is a
    // hard non-retryable error that would stall the cursor forever. Never let an
    // empty name reach the mutation.
    itemName = String(subject || '').trim();
    if (!itemName) { itemName = '(no subject) ' + (messageIdIn || 'unknown'); }
    if (itemName.length > 255) { itemName = itemName.substring(0, 255); }

    detail = 'targetBoard=' + targetBoardName + ' (' + targetBoardId + ') itemName=' + itemName;
  }

  return {
    classification: classification,
    detail: detail,
    labelNames: labelNames.join(','),
    targetBoardId: targetBoardId,
    targetBoardName: targetBoardName,
    targetGroupId: targetGroupId,
    itemName: itemName,
    anchorItemId: anchorItemId
  };
}

// ==========================================================================
// 30_ColumnValues.gs
// ==========================================================================

/**
 * Column-value builder — pure function, no services touched.
 *
 * WRITE-WHAT-EXISTS. Board scope is open: any of the 47 boards whose name matches
 * a label can be a target, and most of them do not have the Gmail sync columns.
 * So this reads the target board's actual column ids and emits only the keys that
 * board has, silently skipping the rest and reporting what it skipped.
 *
 * The alternative — standardising columns across every board — would need doing
 * again for every new board. This way a board that later gains the columns starts
 * getting them with no code change.
 *
 * Corollary: the Gmail Message-ID column can never be relied on as a lookup key,
 * because most boards will not have it. The Sheet ledger is authoritative; these
 * columns are a convenience for humans reading the board.
 */

/**
 * @param {Array<string>} boardColumnIds  Column ids actually present on the board.
 * @param {Object} ctx
 * @param {string} ctx.mailbox          Which mailbox received and labelled it.
 * @param {string} ctx.senderEmail      From address (the client).
 * @param {string} ctx.contactItemId    Contacts item id, or '' when unmatched.
 * @param {string} ctx.threadId
 * @param {string} ctx.headerMessageId  RFC 2822 Message-ID.
 * @param {string} ctx.nowIso           ISO timestamp for the sync stamp.
 * @param {string} ctx.syncMessage
 * @param {string} ctx.syncStatus       Status label; omitted when falsy.
 * @return {{columnValues: Object, written: Array<string>, skipped: Array<string>}}
 */
function buildColumnValues(boardColumnIds, ctx) {
  ctx = ctx || {};
  var present = {};
  (boardColumnIds || []).forEach(function (id) { present[id] = true; });

  var out = {};
  var written = [];
  var skipped = [];

  function put(columnId, value, label) {
    if (value === null || value === undefined || value === '') { return; }
    if (!present[columnId]) { skipped.push(label + ' (' + columnId + ')'); return; }
    out[columnId] = value;
    written.push(label);
  }

  // G247 PM — the person who received and labelled the email. NOTE: this is not
  // the item's `creator`; monday's API cannot set creator, which is always the
  // token owner. The People column is what humans actually read on the board.
  var userId = MAILBOX_TO_MONDAY_USER[String(ctx.mailbox || '').toLowerCase()];
  if (userId) {
    put(COLUMNS.g247pm,
        { personsAndTeams: [{ id: userId, kind: 'person' }] },
        'G247 PM');
  } else if (ctx.mailbox) {
    skipped.push('G247 PM (no monday user mapped for ' + ctx.mailbox + ')');
  }

  // C. Email — always written when we have a sender.
  if (ctx.senderEmail) {
    put(COLUMNS.clientEmail,
        { email: ctx.senderEmail, text: ctx.senderEmail },
        'C. Email');
  }

  // C. Contact — the board relation, linked ONLY when the sender resolved to an
  // existing Contacts row. Unmatched senders leave it empty by design so the
  // Contacts board stays curated.
  if (ctx.contactItemId) {
    put(COLUMNS.clientContact,
        { item_ids: [Number(ctx.contactItemId)] },
        'C. Contact');
  }

  put(COLUMNS.gmailRootMessageId, ctx.headerMessageId, 'Gmail Root Message-ID');
  put(COLUMNS.gmailThreadId, ctx.threadId, 'Gmail Thread ID');

  if (ctx.nowIso) {
    var d = String(ctx.nowIso);
    put(COLUMNS.lastGmailSync,
        { date: d.slice(0, 10), time: d.slice(11, 19) },
        'Last Gmail Sync');
  }

  put(COLUMNS.gmailSyncMessage, ctx.syncMessage, 'Gmail Sync Message');
  if (ctx.syncStatus) {
    put(COLUMNS.gmailSyncStatus, { label: ctx.syncStatus }, 'Gmail Sync Status');
  }

  return { columnValues: out, written: written, skipped: skipped };
}

// ==========================================================================
// 35_UpdateBody.gs
// ==========================================================================

/**
 * Formatting for monday updates — pure functions, no services touched.
 *
 * Kept out of the writer so the bits most likely to be wrong (dates, escaping,
 * truncation) can be tested without a monday token.
 */

/** monday's `original_creation_date` wants 'YYYY-MM-DD HH:mm:ss' in UTC. */
function toMondayDateTime(internalDateMs) {
  var n = Number(internalDateMs);
  if (!n || isNaN(n)) { return ''; }
  var d = new Date(n);
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * monday rejects an over-long update body. 60k is comfortably inside the limit
 * and still holds any realistic email. Truncation is announced in the body
 * rather than silent, so nobody reads a cut-off email as the whole story.
 */
var MAX_UPDATE_CHARS = 60000;

/**
 * Build the HTML for one email as a monday update.
 *
 * Always leads with who sent it and when, because on a monday item the sender is
 * the single thing a reader needs and it is not otherwise visible. Falls back to
 * the plain-text part, then to a clear placeholder — an email whose body we
 * could not decode must still produce a usable update rather than an empty one.
 */
function formatUpdateBody(msg, opts) {
  msg = msg || {};
  opts = opts || {};

  var head = '<b>' + escapeHtml(msg.from || msg.senderEmail || 'unknown sender') + '</b>';
  if (msg.internalDate) {
    head += ' &middot; ' + escapeHtml(toMondayDateTime(msg.internalDate)) + ' UTC';
  }
  if (opts.label) { head += ' &middot; ' + escapeHtml(opts.label); }

  var body;
  if (msg.bodyHtml) {
    body = msg.bodyHtml;
  } else if (msg.bodyText) {
    body = '<pre style="white-space:pre-wrap">' + escapeHtml(msg.bodyText) + '</pre>';
  } else {
    body = '<i>(no readable message body' +
      (msg.bodyError ? ' — ' + escapeHtml(msg.bodyError) : '') +
      '. Open the original in Gmail.)</i>';
  }

  var html = head + '<hr>' + body;

  if (html.length > MAX_UPDATE_CHARS) {
    html = html.substring(0, MAX_UPDATE_CHARS) +
      '<hr><i>[truncated at ' + MAX_UPDATE_CHARS +
      ' characters — open the original in Gmail for the full message]</i>';
  }
  return html;
}

// ==========================================================================
// 40_Store.gs
// ==========================================================================

/**
 * Ledger — the dedup index and the record of what has been synced.
 *
 * Backed by a Google Sheet, but this file never touches SpreadsheetApp. It talks
 * to an adapter (`readAll`, `append`, `ensureSheet`) so the whole thing is
 * testable under Node with a fake. The Apps Script adapter lives in
 * 50_SheetAdapter.gs and is deliberately thin enough to eyeball.
 *
 * WHY A SHEET. PropertiesService caps a single value at 9 KB and the store at
 * 500 KB — the ledger outgrows both. A Sheet is also readable by a human, which
 * partly replaces the per-module execution inspector lost by leaving Make.
 *
 * THE CURSOR INVARIANT
 * --------------------
 * `flush()` MUST succeed before the Gmail cursor is advanced. If the cursor moves
 * first and the flush then fails, those messages are gone: the next run starts
 * after them and no dedup row exists to prove they were handled. Make's
 * equivalent failure — an unconditional write sitting downstream of a conditional
 * one — cost this project four separate bugs. Do not reorder this.
 */

var LEDGER_SHEET = 'ledger';
var LEDGER_HEADERS = ['kind', 'key', 'mondayItemId', 'mailbox', 'threadId',
  'headerMessageId', 'gmailMessageId', 'boardId', 'subject', 'createdAt', 'source',
  'participants'];

/**
 * RFC 2822 Message-IDs arrive as `<abc@host>` from some headers and bare from
 * others; Make's ledger holds both shapes. Normalise before using as a key or
 * dedup silently fails on the bracket difference.
 */
/**
 * Strip the angle brackets and NOTHING ELSE — case is preserved.
 *
 * normalizeMessageId lowercases, which is correct for a dedup KEY (both sides
 * are flattened, so it matches) and wrong for anything that ends up back in an
 * RFC 2822 header. Message-ID local parts are case-sensitive, and the outbound
 * relay puts the ledger's stored value straight into In-Reply-To/References:
 *   In-Reply-To: <caacrcbgabm3eg3bk8nr0vtwqzid=s-atpowzjpwnnhrop7ykzg@mail...>
 * against a real id of <CAAcrCBgAbM3Eg3bK8nr0vTwqZid=S-ATPowzJpWnnHrop7YkZg@...>
 * — so the reply did not join the thread (observed live, 22 Aug).
 *
 * Dedup keys keep using normalizeMessageId. Only the stored HEADER VALUE on the
 * thread-anchor and item rows uses this.
 */
function bareMessageId(raw) {
  return String(raw || '').trim().replace(/^</, '').replace(/>$/, '');
}

/**
 * Every human address on a message, for the participant list.
 *
 * Excludes monday's own item addresses: pulse-<id>@... is plumbing, never
 * somebody you would address a reply to, and leaving it in would mean the
 * outbound relay mailing monday a copy of monday's own email.
 *
 * Order is preserved (From first) so the list reads sensibly to a human opening
 * the ledger. PURE.
 */
function collectParticipants(from, to, cc) {
  var out = [];
  var seen = {};
  [from, to, cc].forEach(function (v) {
    var re = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
    var m;
    while ((m = re.exec(String(v || ''))) !== null) {
      var a = m[0].toLowerCase();
      if (/^pulse-\d+@[a-z0-9.\-]*monday\.com$/i.test(a)) { continue; }
      if (seen[a]) { continue; }
      seen[a] = true;
      out.push(a);
    }
  });
  return out;
}

function normalizeMessageId(raw) {
  return String(raw || '')
    .trim()
    .replace(/^</, '')
    .replace(/>$/, '')
    .toLowerCase();
}

/**
 * @param {{readAll:Function, append:Function, ensureSheet:Function}} adapter
 */
function createLedger(adapter) {
  var index = null;      // built once per run
  var buffer = [];       // rows staged, written on flush()

  function load() {
    adapter.ensureSheet(LEDGER_SHEET, LEDGER_HEADERS);
    var rows = adapter.readAll(LEDGER_SHEET) || [];
    var byMessage = {};
    var byThread = {};
    var byItem = {};
    var byUpdate = {};
    var byParticipants = {};

    rows.forEach(function (r) {
      if (!r || !r.kind) { return; }
      if (r.kind === 'msg') { byMessage[normalizeMessageId(r.key)] = r; }
      else if (r.kind === 'thread') { byThread[String(r.key)] = r; }
      else if (r.kind === 'item') { byItem[String(r.key)] = r; }
      else if (r.kind === 'sent') { byUpdate[String(r.key)] = r; }
      // LAST ONE WINS, deliberately. Participant rows are appended, never
      // updated — the ledger has no update path and adding one would mean
      // finding and rewriting a row under a lock. Appending a fresh row on
      // every reply and taking the newest is simpler and cannot half-succeed.
      else if (r.kind === 'participants') { byParticipants[String(r.key)] = r; }
    });

    index = { byMessage: byMessage, byThread: byThread, byItem: byItem,
              byUpdate: byUpdate, byParticipants: byParticipants,
              rowCount: rows.length };
    return index;
  }

  function ensureLoaded() { if (!index) { load(); } return index; }

  return {
    load: load,

    /**
     * Dedup by RFC 2822 Message-ID, NOT the Gmail message id.
     * Gmail ids are per-mailbox: the same client email in Mark's inbox and
     * Miguel's has two different ids, so keying on them would let both pass and
     * create two monday items for one email. With five mailboxes on shared client
     * threads this is not hypothetical.
     */
    hasMessage: function (headerMessageId) {
      var key = normalizeMessageId(headerMessageId);
      if (!key) { return false; }
      return !!ensureLoaded().byMessage[key];
    },

    /** Item id anchored to a Gmail thread, or '' when the thread is unknown. */
    threadAnchor: function (threadId) {
      if (!threadId) { return ''; }
      var hit = ensureLoaded().byThread[String(threadId)];
      return hit ? String(hit.mondayItemId || '') : '';
    },

    /**
     * Has this monday update already been mirrored out to Gmail?
     *
     * The outbound bridge writes this row BEFORE it sends, so a crash between
     * the two leaves the update marked as handled. That is deliberate: losing
     * one mirror is recoverable by hand, sending a client two copies is not.
     */
    hasMirrored: function (updateId) {
      if (!updateId) { return false; }
      return !!ensureLoaded().byUpdate['u:' + String(updateId)];
    },

    /** Record an outbound mirror. Staged and flushed BEFORE the send. */
    stageMirrored: function (rec) {
      var row = {
        kind: 'sent',
        key: 'u:' + String(rec.updateId || ''),
        mondayItemId: String(rec.mondayItemId || ''),
        mailbox: rec.mailbox || '',
        threadId: rec.threadId || '',
        headerMessageId: normalizeMessageId(rec.headerMessageId),
        gmailMessageId: '',
        boardId: rec.boardId || '',
        subject: rec.subject || '',
        createdAt: rec.createdAt || '',
        source: 'monday-outbound'
      };
      buffer.push(row);
      ensureLoaded().byUpdate[row.key] = row;
      return row;
    },

    /**
     * Who is on this Gmail thread, newest list first written.
     *
     * The outbound relay runs as projects@group247ww.com and CANNOT read the
     * thread — it lives in the PM's mailbox. So the intake, which does run as
     * the PM, records the participants here and the relay reads them from the
     * ledger. Refreshed on every append, which is exactly when somebody joins
     * or leaves a conversation.
     */
    threadParticipants: function (threadId) {
      if (!threadId) { return []; }
      var hit = ensureLoaded().byParticipants[String(threadId)];
      if (!hit || !hit.participants) { return []; }
      return String(hit.participants).split(',').map(function (a) {
        return a.trim().toLowerCase();
      }).filter(function (a) { return !!a; });
    },

    /** Append the current participant list for a thread. */
    stageParticipants: function (rec) {
      var list = rec.participants || [];
      var row = {
        kind: 'participants',
        key: String(rec.threadId || ''),
        mondayItemId: String(rec.mondayItemId || ''),
        mailbox: rec.mailbox || '',
        threadId: String(rec.threadId || ''),
        headerMessageId: '',
        gmailMessageId: rec.gmailMessageId || '',
        boardId: rec.boardId || '',
        subject: rec.subject || '',
        createdAt: rec.createdAt || '',
        source: 'apps-script',
        participants: list.join(', ')
      };
      buffer.push(row);
      if (row.key) { ensureLoaded().byParticipants[row.key] = row; }
      return row;
    },

    /** Reverse index: what Gmail thread does this monday item belong to. */
    itemThread: function (itemId) {
      if (!itemId) { return null; }
      return ensureLoaded().byItem[String(itemId)] || null;
    },

    /**
     * Stage a processed message. Buffered, not written — see the cursor
     * invariant above. Also updates the in-memory index immediately so a second
     * copy of the same message inside the SAME run is deduped.
     */
    stageMessage: function (rec) {
      var key = normalizeMessageId(rec.headerMessageId);
      var row = {
        kind: 'msg',
        key: key,
        mondayItemId: rec.mondayItemId || '',
        mailbox: rec.mailbox || '',
        threadId: rec.threadId || '',
        headerMessageId: key,
        gmailMessageId: rec.gmailMessageId || '',
        boardId: rec.boardId || '',
        subject: rec.subject || '',
        createdAt: rec.createdAt || '',
        source: rec.source || 'apps-script'
      };
      buffer.push(row);
      if (key) { ensureLoaded().byMessage[key] = row; }
      return row;
    },

    /** Stage the thread anchor — what makes later replies append, not create. */
    stageThreadAnchor: function (rec) {
      var row = {
        kind: 'thread',
        key: String(rec.threadId || ''),
        mondayItemId: rec.mondayItemId || '',
        mailbox: rec.mailbox || '',
        threadId: String(rec.threadId || ''),
        headerMessageId: bareMessageId(rec.headerMessageId),
        gmailMessageId: rec.gmailMessageId || '',
        boardId: rec.boardId || '',
        subject: rec.subject || '',
        createdAt: rec.createdAt || '',
        source: rec.source || 'apps-script'
      };
      buffer.push(row);
      if (row.key) { ensureLoaded().byThread[row.key] = row; }
      return row;
    },

    /** Stage the reverse index the outbound bridge needs to find the thread. */
    stageItemIndex: function (rec) {
      var row = {
        kind: 'item',
        key: String(rec.mondayItemId || ''),
        mondayItemId: String(rec.mondayItemId || ''),
        mailbox: rec.mailbox || '',
        threadId: rec.threadId || '',
        headerMessageId: bareMessageId(rec.headerMessageId),
        gmailMessageId: rec.gmailMessageId || '',
        boardId: rec.boardId || '',
        subject: rec.subject || '',
        createdAt: rec.createdAt || '',
        source: rec.source || 'apps-script'
      };
      buffer.push(row);
      if (row.key) { ensureLoaded().byItem[row.key] = row; }
      return row;
    },

    pending: function () { return buffer.length; },

    /**
     * Write everything staged. Returns the number of rows written.
     * MUST be called, and must return without throwing, BEFORE the caller
     * advances the Gmail cursor.
     */
    flush: function () {
      if (buffer.length === 0) { return 0; }
      var rows = buffer.map(function (r) {
        return LEDGER_HEADERS.map(function (h) { return r[h] === undefined ? '' : r[h]; });
      });
      adapter.append(LEDGER_SHEET, rows);
      var n = buffer.length;
      buffer = [];
      return n;
    }
  };
}

// ==========================================================================
// 45_RunLog.gs
// ==========================================================================

/**
 * Structured run log.
 *
 * THIS IS THE REPLACEMENT FOR MAKE'S EXECUTION INSPECTOR, and it is the single
 * biggest thing given up by leaving Make. Every diagnosis in this project came
 * from reading a Make module's inputs and outputs. Losing that without replacing
 * it deliberately is how the first mystery failure costs a day.
 *
 * So: one row per decision, every run, whether or not anything happened —
 * including the runs where nothing happened, because "nothing happened" is
 * exactly the symptom that was hardest to diagnose in Make.
 *
 * Rows are buffered and flushed once per run. The log is best-effort: a failure
 * to write it must never abort the run or block the cursor, because losing a log
 * line is a nuisance and losing an email is not. This is the one place where
 * swallowing an error is the right call — and it is swallowed loudly, to
 * console.error, never silently.
 */

var RUNLOG_SHEET = 'runlog';
var RUNLOG_HEADERS = ['ts', 'runId', 'mailbox', 'level', 'stage', 'classification',
  'gmailMessageId', 'headerMessageId', 'threadId', 'boardId', 'itemId', 'detail', 'ms'];

/** Keep the log bounded; oldest rows are trimmed by the adapter when it grows. */
var RUNLOG_MAX_ROWS = 20000;

function createRunLog(adapter, opts) {
  opts = opts || {};
  var runId = opts.runId || 'run-unknown';
  var mailbox = opts.mailbox || '';
  var nowFn = opts.now || function () { return new Date().toISOString(); };
  var buffer = [];
  var counts = { info: 0, warn: 0, error: 0 };
  var startedMs = opts.startedMs || 0;

  function write(level, stage, fields) {
    fields = fields || {};
    counts[level] = (counts[level] || 0) + 1;
    buffer.push({
      ts: nowFn(),
      runId: runId,
      mailbox: fields.mailbox || mailbox,
      level: level,
      stage: stage,
      classification: fields.classification || '',
      gmailMessageId: fields.gmailMessageId || '',
      headerMessageId: fields.headerMessageId || '',
      threadId: fields.threadId || '',
      boardId: fields.boardId || '',
      itemId: fields.itemId || '',
      detail: fields.detail || '',
      ms: fields.ms === undefined ? '' : fields.ms
    });
  }

  return {
    runId: runId,
    info: function (stage, fields) { write('info', stage, fields); },
    warn: function (stage, fields) { write('warn', stage, fields); },
    error: function (stage, fields) { write('error', stage, fields); },

    /** One row per candidate, carrying the classifier's own reason string. */
    decision: function (candidate, verdict, extra) {
      extra = extra || {};
      write(extra.level || 'info', 'classify', {
        classification: verdict.classification,
        gmailMessageId: candidate.gmailMessageId || candidate.mid || '',
        headerMessageId: candidate.headerMessageId || '',
        threadId: candidate.threadId || candidate.tid || '',
        boardId: verdict.targetBoardId || '',
        itemId: verdict.anchorItemId || extra.itemId || '',
        detail: verdict.detail || '',
        ms: extra.ms === undefined ? '' : extra.ms
      });
    },

    counts: function () { return { info: counts.info, warn: counts.warn, error: counts.error }; },
    pending: function () { return buffer.length; },

    /**
     * Best-effort. Never throws: a lost log line must not cost an email.
     * The swallow is loud — it goes to console.error and shows up in Cloud
     * Logging, which is the difference between this and the `builtin:Ignore`
     * that hid a 401 for two hours on 11 Aug.
     */
    flush: function () {
      if (buffer.length === 0) { return 0; }
      try {
        adapter.ensureSheet(RUNLOG_SHEET, RUNLOG_HEADERS);
        var rows = buffer.map(function (r) {
          return RUNLOG_HEADERS.map(function (h) { return r[h] === undefined ? '' : r[h]; });
        });
        adapter.append(RUNLOG_SHEET, rows);
        if (adapter.trimTo) { adapter.trimTo(RUNLOG_SHEET, RUNLOG_MAX_ROWS); }
        var n = buffer.length;
        buffer = [];
        return n;
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[G247] RUN LOG WRITE FAILED (run continued): ' + (e && e.message));
          console.error('[G247] unwritten rows: ' + JSON.stringify(buffer).slice(0, 4000));
        }
        buffer = [];
        return -1;
      }
    },

    /** Human-readable one-liner for Cloud Logging. */
    summary: function (extra) {
      extra = extra || {};
      var parts = ['[G247]', runId, mailbox,
        'candidates=' + (extra.candidates === undefined ? '?' : extra.candidates),
        'created=' + (extra.created || 0),
        'appended=' + (extra.appended || 0),
        'skipped=' + (extra.skipped || 0),
        'warn=' + counts.warn, 'errors=' + counts.error];
      if (startedMs && extra.endedMs) { parts.push('ms=' + (extra.endedMs - startedMs)); }
      return parts.join(' ');
    }
  };
}

// ==========================================================================
// 50_SheetAdapter.gs
// ==========================================================================

/**
 * Apps Script Sheet adapter — the only file here that touches SpreadsheetApp.
 *
 * Deliberately thin and boring: everything with logic in it lives in a pure file
 * with tests, and this is the part that can only be verified by running it. Keep
 * it that way. If you find yourself adding a condition here, it belongs in
 * 40_Store.gs instead.
 *
 * CONCURRENCY — READ THIS BEFORE ROLLING OUT ANOTHER MAILBOX.
 *
 * Five mailboxes share one ledger Sheet. `LockService.getScriptLock()` is scoped
 * to the SCRIPT PROJECT, not to the user, so it serialises every user of ONE
 * project — and does nothing at all between separate copies of the project.
 *
 * Therefore all five people must install their trigger on the SAME shared Apps
 * Script project. Five separate copies would each hold their own lock, and two
 * simultaneous appends would both compute the same `getLastRow() + 1` and one
 * would overwrite the other: silently lost ledger rows, which later means
 * duplicate monday items.
 *
 * The cursor is safe under sharing because it lives in UserProperties
 * (see stateStore_ in 90_Entrypoints.gs), which are per-user per-project.
 *
 * Residual race, accepted knowingly: two people labelling the SAME email within
 * the same minute can both pass the dedup check before either writes, producing
 * two items. It needs simultaneous manual labelling of one message, so it is
 * rare; if it ever bites, stagger the triggers rather than adding machinery.
 */

var LOCK_WAIT_MS = 30000;

function createSheetAdapter(spreadsheetId) {
  var ssCache = null;

  function ss() {
    if (!ssCache) { ssCache = SpreadsheetApp.openById(spreadsheetId); }
    return ssCache;
  }

  function sheetByName(name, headers) {
    var sh = ss().getSheetByName(name);
    if (!sh) {
      sh = ss().insertSheet(name);
      if (headers && headers.length) {
        sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
        sh.setFrozenRows(1);
      }
      return sh;
    }

    // AN EXISTING SHEET MAY PREDATE A COLUMN.
    //
    // Rows are written by mapping LEDGER_HEADERS to an array, so once a header
    // is added the writer emits one more value per row. If the sheet's header
    // row still has the old width, that value lands in a column with no label —
    // and readAll(), which keys by the header row, would never expose it. The
    // data would be written and silently unreadable, which is this project's
    // favourite kind of bug.
    //
    // So: append any missing headers, in order, before anything is written.
    // Idempotent, one row read per run, and it removes the need for anyone to
    // remember a migration step.
    if (headers && headers.length) {
      var width = Math.max(sh.getLastColumn(), 1);
      var existing = sh.getRange(1, 1, 1, width).getValues()[0]
        .map(function (h) { return String(h || '').trim(); });
      // Trailing blanks are not columns. Without this, a sheet whose header
      // row is empty would get its headers written starting at column 2 while
      // the writer still fills column 1 — every value off by one.
      while (existing.length && existing[existing.length - 1] === '') {
        existing.pop();
      }

      // Rows are written POSITIONALLY from `headers` but read back by the
      // sheet's own header row, so the two only agree while the sheet's
      // headers are this list's prefix, in order. Appending is safe; anything
      // else is a misalignment that would write real data into the wrong
      // column and read it back under the wrong name. Fail loudly instead.
      for (var i = 0; i < existing.length; i++) {
        if (existing[i] !== headers[i]) {
          throw new Error('sheet "' + name + '" column ' + (i + 1) +
            ' is "' + existing[i] + '" but the code expects "' +
            (headers[i] === undefined ? '(nothing)' : headers[i]) +
            '". Refusing to write misaligned rows.');
        }
      }

      var missing = headers.slice(existing.length);
      if (missing.length) {
        sh.getRange(1, existing.length + 1, 1, missing.length)
          .setValues([missing]).setFontWeight('bold');
        if (!existing.length) { sh.setFrozenRows(1); }
      }
    }
    return sh;
  }

  function withLock(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) {
      throw new Error('could not acquire script lock within ' + LOCK_WAIT_MS + 'ms');
    }
    try { return fn(); } finally { lock.releaseLock(); }
  }

  return {
    ensureSheet: function (name, headers) {
      sheetByName(name, headers);
    },

    /** Whole sheet as objects keyed by the header row. */
    readAll: function (name) {
      var sh = ss().getSheetByName(name);
      if (!sh) { return []; }
      var values = sh.getDataRange().getValues();
      if (values.length < 2) { return []; }
      var headers = values[0];
      var out = [];
      for (var i = 1; i < values.length; i++) {
        var row = {};
        for (var c = 0; c < headers.length; c++) {
          row[headers[c]] = values[i][c];
        }
        out.push(row);
      }
      return out;
    },

    /** Append rows (array of arrays) in one write, under the script lock. */
    append: function (name, rows) {
      if (!rows || !rows.length) { return; }
      withLock(function () {
        var sh = ss().getSheetByName(name);
        if (!sh) { throw new Error('sheet "' + name + '" does not exist; call ensureSheet first'); }
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      });
    },

    /** Keep the run log bounded. Deletes oldest rows, never the header. */
    trimTo: function (name, maxRows) {
      var sh = ss().getSheetByName(name);
      if (!sh) { return; }
      var last = sh.getLastRow();
      var excess = last - 1 - maxRows;
      if (excess > 0) {
        withLock(function () { sh.deleteRows(2, excess); });
      }
    }
  };
}

// ==========================================================================
// 55_Migration.gs
// ==========================================================================

/**
 * ONE-OFF MIGRATION — copy Make data store 90115 into the Sheet ledger.
 *
 * Run `importMakeLedger()` by hand, once, BEFORE the first live run.
 * It is idempotent: re-running skips anything already present.
 *
 * WHY THIS IS NOT A STRAIGHT COPY
 * -------------------------------
 * Make keyed its message rows on the GMAIL MESSAGE ID, which is per-mailbox: the
 * same client email in Mark's inbox and Miguel's has two different ids, so with
 * five mailboxes both copies would pass dedup and create two monday items for one
 * email. This ledger keys on the RFC 2822 Message-ID header instead, which is
 * identical in every mailbox that received the message.
 *
 * Make's rows do not carry that header, so this function resolves it from Gmail
 * per message. That resolution HAS to happen here rather than being precomputed:
 * the header is only readable with real Gmail access, running as the mailbox
 * owner.
 *
 * WHAT HAPPENS TO A MESSAGE THAT NO LONGER EXISTS
 * -----------------------------------------------
 * Deleted or purged messages cannot be resolved and are skipped, counted, and
 * listed. That is safe: the THREAD ANCHOR for that conversation still imports,
 * so a future reply on it still appends rather than creating a duplicate. The
 * only loss is that re-labelling that exact deleted message would create a new
 * item — which cannot happen, because it no longer exists.
 *
 * Snapshot taken from data store 90115 on 2026-08-11: 13 thread anchors,
 * 5 reverse-index rows, 29 message rows.
 */

var MAKE_MAILBOX = 'msalvana@group247ww.com';

/** [threadId, mondayItemId, postedAt] */
var MAKE_THREAD_ROWS = [
  ["19fb1ea4b67bf895", "12737268531", "2026-08-06T16:36:01.000Z"],
  ["19fd79d47201e202", "12737207642", "2026-08-06T16:25:57.000Z"],
  ["19fd67a57dec799f", "12733552359", "2026-08-06T10:14:32.000Z"],
  ["19fcff98b7fa8f43", "12733122620", "2026-08-06T08:47:06.000Z"],
  ["19fd5583a16b63f5", "12741718514", "2026-08-07T00:01:17.169Z"],
  ["19fd9d89f498c902", "12742235609", "2026-08-07T01:55:07.865Z"],
  ["19fd985f5b9b05b3", "12742281232", "2026-08-07T01:57:53.553Z"],
  ["19fda1629f19f8a9", "12742533601", "2026-08-07T02:38:53.345Z"],
  ["19fda4188c0fcc81", "12742912962", "2026-08-07T03:26:56.000Z"],
  ["19fdb679003fe950", "12757927043", "2026-08-10T01:48:52.223Z"],
  ["19fc65a6571be363", "12758210026", "2026-08-10T02:37:10.004Z"],
  ["19feb3b8857cb115", "12768466395", "2026-08-11T00:46:41.367Z"],
  ["19fee44a404a02ba", "12768466923", "2026-08-11T00:50:31.356Z"]
];

/** [mondayItemId, threadId, headerMessageId, subject, postedAt] */
var MAKE_ITEM_ROWS = [
  ["12742533601", "19fda1629f19f8a9", "CAAcrcBGgiqCAEnR__stGg_SLhddU6xckWR0NgG+q5vN-m4pefw@mail.gmail.com", "Create a banner on the website", "2026-08-07T02:38:51.726Z"],
  ["12757927043", "19fdb679003fe950", "0c1ce9bc511a8be5012f9bd5363df0f4@mail.gmail.com", "FW: WordPress 7.0.3 is out. Patch today.", "2026-08-10T01:48:52.262Z"],
  ["12758210026", "19fc65a6571be363", "2c7824ffcd3250c9afa1eb79f4428006@mail.gmail.com", "FW: Encountered warnings in scenario Fillout Contacts on Project Creation", "2026-08-10T02:37:10.035Z"],
  ["12768466395", "19feb3b8857cb115", "CAKwfefDhu-ZMmQn-bUW0o-2A+=ovjdo9=csfMnR+FGBCrqoRfQ@mail.gmail.com", "Spike Out of Office on leave Re: G247 Website Redesign", "2026-08-11T00:46:41.392Z"],
  ["12768466923", "19fee44a404a02ba", "CAAcrcBGWt51FcGwTFMABFQ_XGoBgWQy+e6rMj99bXFNn3YHQHg@mail.gmail.com", "Update the ReTrieve Homepage Banner", "2026-08-11T00:50:31.387Z"]
];

/** [gmailMessageId, mondayItemId, source, postedAt] */
var MAKE_MSG_ROWS = [
  ["19fd58a1eb3a5a22", "backfill-unknown", "backfill-from-90183-dryrun", "2026-08-06T15:45:00.000Z"],
  ["19fd58ba63941486", "backfill-unknown", "backfill-from-90183-dryrun", "2026-08-06T15:45:00.000Z"],
  ["19fd79d47201e202", "12737207642", "gmail-pipeline", "2026-08-06T16:25:58.083Z"],
  ["19fb35d499c2638f", "12737268531", "gmail-pipeline", "2026-08-06T16:36:02.722Z"],
  ["19fceaeebf153156", "12737268531", "gmail-pipeline-append", "2026-08-06T16:48:19.185Z"],
  ["19fd67a93e8c24e3", "12733552359", "gmail-pipeline-append", "2026-08-06T16:59:33.953Z"],
  ["19fd693c96af540c", "12733552359", "gmail-pipeline-append", "2026-08-06T16:59:37.297Z"],
  ["19fd801a6dfe858e", "12733552359", "gmail-pipeline-append", "2026-08-06T16:59:40.970Z"],
  ["19fd5583a16b63f5", "12741718514", "gmail-pipeline", "2026-08-07T00:01:15.610Z"],
  ["19fd9d89f498c902", "12742235609", "gmail-pipeline", "2026-08-07T01:55:05.946Z"],
  ["19fd985f5b9b05b3", "12742281232", "gmail-pipeline", "2026-08-07T01:57:52.144Z"],
  ["19fda0eadf8aef9c", "12742281232", "gmail-pipeline-append", "2026-08-07T02:30:33.436Z"],
  ["19fda0f7bb21874f", "12733552359", "gmail-pipeline-append", "2026-08-07T02:31:24.673Z"],
  ["19fda1629f19f8a9", "12742533601", "gmail-pipeline", "2026-08-07T02:38:51.726Z"],
  ["19fda19176144e4a", "12742533601", "gmail-pipeline-append", "2026-08-07T02:41:59.275Z"],
  ["19fda1cc0ceee0de", "12742533601", "gmail-pipeline-append", "2026-08-07T02:54:10.123Z"],
  ["19fda2940b11422a", "12742533601", "gmail-pipeline-append", "2026-08-07T02:59:38.461Z"],
  ["19fda4188c0fcc81", "12742912962", "gmail-pipeline", "2026-08-07T03:26:56.376Z"],
  ["19fda42e836b2fff", "12742912962", "gmail-pipeline-append", "2026-08-07T05:37:59.898Z"],
  ["19fdab1dc7f25daf", "12742912962", "gmail-pipeline-append", "2026-08-07T05:38:10.159Z"],
  ["19fdb923fad6ebde", "12742533601", "monday-outbound", "2026-08-07T09:33:43.476Z"],
  ["19fdb679003fe950", "12757927043", "gmail-pipeline", "2026-08-10T01:48:52.191Z"],
  ["19fc65a6571be363", "12758210026", "gmail-pipeline", "2026-08-10T02:37:09.972Z"],
  ["19fe98890514963f", "12758210026", "gmail-pipeline-append", "2026-08-10T02:38:03.012Z"],
  ["19fe9898ed09e95e", "12758210026", "gmail-pipeline-append", "2026-08-10T02:39:09.143Z"],
  ["19fe98ccbfb647fe", "12758210026", "monday-outbound", "2026-08-10T02:42:27.705Z"],
  ["19feb3b8857cb115", "12768466395", "gmail-pipeline", "2026-08-11T00:46:41.345Z"],
  ["19fee44a404a02ba", "12768466923", "gmail-pipeline", "2026-08-11T00:50:31.332Z"],
  ["19fee4ef7c1c7faa", "12768466923", "gmail-pipeline-append", "2026-08-11T00:53:08.612Z"]
];

/**
 * Resolve a Gmail message id to its RFC 2822 Message-ID header.
 * Returns '' when the message is gone or the header is absent.
 */
function resolveHeaderMessageId_(gmailMessageId) {
  try {
    var msg = Gmail.Users.Messages.get('me', gmailMessageId, {
      format: 'metadata',
      metadataHeaders: ['Message-ID']
    });
    var hs = (msg && msg.payload && msg.payload.headers) || [];
    for (var i = 0; i < hs.length; i++) {
      if (String(hs[i].name).toLowerCase() === 'message-id') {
        return normalizeMessageId(hs[i].value);
      }
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * THE MIGRATION. Run once, by hand, before going live.
 * Order is deliberate: anchors and the reverse index first, because they are the
 * rows that prevent duplicate ITEMS, and they need no Gmail lookup. Message rows
 * follow and are allowed to fail individually.
 */
function importMakeLedger() {
  var adapter = createSheetAdapter(LEDGER_SPREADSHEET_ID);
  var ledger = createLedger(adapter);
  ledger.load();

  var out = { threads: 0, items: 0, messages: 0, skippedExisting: 0, unresolved: [] };

  // --- thread anchors: what makes a later reply append instead of create ----
  MAKE_THREAD_ROWS.forEach(function (r) {
    if (ledger.threadAnchor(r[0])) { out.skippedExisting++; return; }
    ledger.stageThreadAnchor({
      threadId: r[0], mondayItemId: r[1], mailbox: MAKE_MAILBOX,
      createdAt: r[2], source: 'make-import'
    });
    out.threads++;
  });

  // --- reverse index: how the outbound bridge finds the Gmail thread -------
  MAKE_ITEM_ROWS.forEach(function (r) {
    if (ledger.itemThread(r[0])) { out.skippedExisting++; return; }
    ledger.stageItemIndex({
      mondayItemId: r[0], threadId: r[1], headerMessageId: r[2],
      subject: r[3], mailbox: MAKE_MAILBOX, createdAt: r[4], source: 'make-import'
    });
    out.items++;
  });

  // --- message dedup rows: need the header resolved from Gmail -------------
  MAKE_MSG_ROWS.forEach(function (r) {
    var gid = r[0];
    var hdr = resolveHeaderMessageId_(gid);
    if (!hdr) { out.unresolved.push(gid); return; }
    if (ledger.hasMessage(hdr)) { out.skippedExisting++; return; }
    ledger.stageMessage({
      headerMessageId: hdr, gmailMessageId: gid, mondayItemId: r[1],
      mailbox: MAKE_MAILBOX, createdAt: r[3], source: 'make-import:' + r[2]
    });
    out.messages++;
  });

  // Ledger flush must succeed or nothing is claimed as imported.
  var written = ledger.flush();

  var summary = 'imported ' + written + ' rows (' +
    out.threads + ' thread anchors, ' + out.items + ' reverse-index, ' +
    out.messages + ' messages); ' + out.skippedExisting + ' already present; ' +
    out.unresolved.length + ' unresolved';
  console.log('[G247] ' + summary);
  if (out.unresolved.length) {
    console.log('[G247] unresolved (deleted or header missing) — their thread anchors still imported: ' +
      out.unresolved.join(', '));
  }
  out.written = written;
  out.summary = summary;
  return out;
}

/** Read-only check of what the import would do. Run this first. */
function previewMakeLedgerImport() {
  var adapter = createSheetAdapter(LEDGER_SPREADSHEET_ID);
  var ledger = createLedger(adapter);
  ledger.load();
  var resolved = 0, unresolved = [];
  MAKE_MSG_ROWS.forEach(function (r) {
    if (resolveHeaderMessageId_(r[0])) { resolved++; } else { unresolved.push(r[0]); }
  });
  var out = {
    threadAnchorsToAdd: MAKE_THREAD_ROWS.filter(function (r) { return !ledger.threadAnchor(r[0]); }).length,
    itemRowsToAdd: MAKE_ITEM_ROWS.filter(function (r) { return !ledger.itemThread(r[0]); }).length,
    messagesResolvable: resolved,
    messagesUnresolvable: unresolved.length,
    unresolved: unresolved
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// ==========================================================================
// 60_Intake.gs
// ==========================================================================

/**
 * Intake orchestrator.
 *
 * Every external service arrives as an injected dependency, so the whole control
 * flow — including the failure paths — is exercised under Node with fakes. The
 * Apps Script wiring is in 90_Entrypoints.gs and contains no logic.
 *
 * SHADOW MODE
 * -----------
 * `opts.shadow === true` reads Gmail, classifies, and logs every decision, but
 * writes NOTHING: no monday item, no ledger row. It runs on its OWN cursor key so
 * shadow traffic never moves the live cursor.
 *
 * NOTE: the live cursor starts EMPTY. Make's cursor lives in a Make data store,
 * not in Script Properties, so there is nothing here to inherit. The first
 * runLive therefore SEEDS and processes nothing — see the seed branch below.
 * Label the test email AFTER that first run, not before.
 *
 * ORDER OF OPERATIONS — do not rearrange
 * --------------------------------------
 *   1. classify and act on every candidate
 *   2. ledger.flush()          <- throws if the write fails
 *   3. advance the cursor      <- only reached when step 2 succeeded
 *   4. runLog.flush()          <- best effort, never blocks anything
 *
 * If 3 ran before 2, a failed ledger write would leave the cursor past messages
 * with no record that they were handled: silently lost email. This is the same
 * failure class as Make's `builtin:Ignore` swallowing an error, which cost this
 * project four separate bugs.
 */

/**
 * @param {Object} deps
 * @param {Object} deps.gmail   {getProfileEmail, historyList, messagesGet, labelsList}
 * @param {Object} deps.monday  {boardNameMap}
 * @param {Object} deps.ledger  from createLedger()
 * @param {Object} deps.state   {getCursor, setCursor}
 * @param {Object} deps.log     from createRunLog()
 * @param {Function} [deps.now] () => ISO string
 * @param {Object} [deps.writer] {createProject, appendUpdate, deadLetter} — omit in shadow
 * @param {Object} opts
 * @param {boolean} [opts.shadow]
 * @return {Object} run summary
 */
function runIntake(deps, opts) {
  opts = opts || {};
  var shadow = opts.shadow === true;
  var log = deps.log;
  var ledger = deps.ledger;
  var now = deps.now || function () { return new Date().toISOString(); };

  var summary = {
    mailbox: '', shadow: shadow, candidates: 0,
    created: 0, appended: 0, skipped: 0, deadLettered: 0, errors: 0,
    cursorFrom: '', cursorTo: '', advanced: false, decisions: []
  };

  // ---- 1. whose mailbox is this, and is it in the pipeline? ----------------
  var mailbox = String(deps.gmail.getProfileEmail() || '').toLowerCase();
  summary.mailbox = mailbox;

  if (!Object.prototype.hasOwnProperty.call(MAILBOX_TO_MONDAY_USER, mailbox)) {
    log.warn('allowlist', { mailbox: mailbox, detail: 'mailbox not in MAILBOX_TO_MONDAY_USER; nothing done' });
    log.flush();
    return summary;
  }

  // ---- 2. cursor ----------------------------------------------------------
  var cursorKey = (shadow ? 'shadowCursor:' : 'cursor:') + mailbox;
  var startHistoryId = deps.state.getCursor(cursorKey);
  summary.cursorFrom = startHistoryId || '';

  if (!startHistoryId) {
    // No cursor: seed from the current mailbox state rather than replaying all
    // history. A first run must never backfill years of mail into monday.
    var seeded = deps.gmail.currentHistoryId();
    deps.state.setCursor(cursorKey, seeded);
    log.info('seed', { mailbox: mailbox, detail:
      'FIRST RUN — SEEDED at historyId ' + seeded + ' and processed NOTHING. ' +
      'This is the no-backfill guard: a first run must never replay old mail into monday. ' +
      'Anything labelled BEFORE now is behind the cursor and will not be picked up. ' +
      'Label an email now and run again.' });
    log.flush();
    summary.cursorTo = seeded;
    return summary;
  }

  // ---- 3. what changed? ---------------------------------------------------
  var raw;
  try {
    raw = deps.gmail.historyList(startHistoryId);
  } catch (e) {
    // A 404 means the cursor is older than Gmail's history window. Re-seed
    // rather than stall forever; the ledger still prevents duplicates.
    log.error('history', { mailbox: mailbox, detail: 'historyList failed: ' + (e && e.message) });
    summary.errors++;
    log.flush();
    return summary;
  }

  var extracted = extractCandidates(raw, startHistoryId);
  summary.candidates = extracted.count;

  if (extracted.count === 0) {
    // Log the quiet runs too. "Nothing happened" was the hardest symptom to
    // diagnose in Make precisely because it left no trace.
    log.info('idle', {
      mailbox: mailbox,
      detail: 'no candidates; scanned ' + extracted.eventsScanned + ' events in ' +
              extracted.rawHistoryCount + ' history records'
    });
    deps.state.setCursor(cursorKey, extracted.idleHistoryId);
    summary.cursorTo = extracted.idleHistoryId;
    summary.advanced = true;
    log.flush();
    return summary;
  }

  // ---- 4. maps needed to classify ------------------------------------------
  var labelMaps = deps.gmail.labelsList();
  var boardNameMap = deps.monday.boardNameMap();

  // ---- 5. one decision per candidate ---------------------------------------
  extracted.items.forEach(function (cand) {
    var decision = null;
    try {
      var msg = deps.gmail.messagesGet(cand.mid);

      // TWO FORMS OF THE SAME ID, AND THEY ARE NOT INTERCHANGEABLE.
      //
      // headerMessageId is lowercased and is the DEDUP KEY: both sides of a
      // comparison get flattened, so it matches, and every ledger key ever
      // written uses this form.
      //
      // rawMessageId keeps the case Gmail gave us and is what goes back into an
      // RFC 2822 header. Message-ID local parts are case-sensitive, so the
      // outbound relay's In-Reply-To must carry this one. Flattening it here is
      // what made relayed mail start a new conversation instead of joining the
      // project thread — and it was invisible for weeks because dedup, which
      // uses the other form, kept working perfectly.
      var headerMessageId = normalizeMessageId(msg.headerMessageId);
      var rawMessageId = bareMessageId(msg.headerMessageId);

      decision = classifyMessage({
        fetchOk: !!msg.ok,
        gmailMessageId: cand.mid,
        headerMessageId: headerMessageId,
        threadId: msg.threadId || cand.tid,
        fromHeader: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        syncOrigin: msg.syncOrigin,
        labelIdsCsv: (msg.labelIds || []).join(','),
        labelMap: labelMaps.labelMap,
        userLabelMap: labelMaps.userLabelMap,
        boardNameMap: boardNameMap,
        alreadyProcessed: ledger.hasMessage(headerMessageId),
        threadKnown: !!ledger.threadAnchor(msg.threadId || cand.tid),
        threadAnchorItemId: ledger.threadAnchor(msg.threadId || cand.tid)
      });

      log.decision({
        gmailMessageId: cand.mid,
        headerMessageId: headerMessageId,
        threadId: msg.threadId || cand.tid
      }, decision);

      summary.decisions.push({
        gmailMessageId: cand.mid,
        headerMessageId: headerMessageId,
        threadId: msg.threadId || cand.tid,
        classification: decision.classification,
        targetBoardId: decision.targetBoardId,
        itemName: decision.itemName
      });

      if (shadow) {
        // Observe only. No monday call, no ledger row, nothing to undo.
        if (decision.classification === 'create-matched-board') { summary.created++; }
        else if (decision.classification === 'append-to-existing-item') { summary.appended++; }
        else { summary.skipped++; }
        return;
      }

      applyDecision(deps, {
        mailbox: mailbox, candidate: cand, message: msg,
        headerMessageId: headerMessageId, rawMessageId: rawMessageId,
        decision: decision, now: now
      }, summary);

    } catch (e) {
      // One poison message must never stall the mailbox. Dead-letter it, log it,
      // and keep going — the cursor still advances past it, which is what
      // dead-lettering means.
      summary.errors++;
      log.error('candidate', {
        mailbox: mailbox, gmailMessageId: cand.mid, threadId: cand.tid,
        detail: 'failed: ' + (e && e.message)
      });
      if (!shadow && deps.writer && deps.writer.deadLetter) {
        try {
          deps.writer.deadLetter({
            mailbox: mailbox, gmailMessageId: cand.mid, threadId: cand.tid,
            targetBoard: decision ? decision.targetBoardName : '',
            error: String((e && e.message) || e), failedAt: now()
          });
          summary.deadLettered++;
        } catch (e2) {
          log.error('deadletter', { mailbox: mailbox, detail: 'dead-letter write failed: ' + (e2 && e2.message) });
        }
      }
    }
  });

  // ---- 6. ledger BEFORE cursor. Never the other way round. -----------------
  if (!shadow) {
    ledger.flush();   // throws on failure; the cursor below is then never reached
  }

  // ---- 7. cursor -----------------------------------------------------------
  var target = extracted.hasMore ? extracted.idleHistoryId : (extracted.newHistoryId || extracted.idleHistoryId);
  deps.state.setCursor(cursorKey, target);
  summary.cursorTo = target;
  summary.advanced = true;

  if (extracted.hasMore) {
    log.info('batch', { mailbox: mailbox, detail: 'more history remains; next run continues from ' + target });
  }

  // ---- 8. log last, best effort -------------------------------------------
  log.info('done', { mailbox: mailbox, detail: log.summary(summary) });
  log.flush();

  return summary;
}

/** Writes for one classified message. Only reached when not in shadow mode. */
function applyDecision(deps, ctx, summary) {
  var d = ctx.decision;
  var w = deps.writer;
  var msg = ctx.message;

  if (d.classification === 'create-matched-board') {
    var created = w.createProject({
      boardId: d.targetBoardId,
      groupId: d.targetGroupId,
      itemName: d.itemName,
      mailbox: ctx.mailbox,
      senderEmail: msg.senderEmail,
      // `from` carries the display name; bodyText and bodyError are the
      // fallbacks formatUpdateBody needs. Omitting them made a plain-text email
      // render as "(no readable message body)" with the text sitting unused on
      // the message object.
      from: msg.from,
      threadId: msg.threadId,
      headerMessageId: ctx.headerMessageId,
      gmailMessageId: ctx.candidate.mid,
      subject: msg.subject,
      bodyHtml: msg.bodyHtml,
      bodyText: msg.bodyText,
      bodyError: msg.bodyError,
      attachments: msg.attachments || [],
      internalDate: msg.internalDate,
      nowIso: ctx.now()
    });

    // stageMessage re-normalises for its key, so the raw form here is safe for
    // all three: the msg row still gets a lowercased key, while the thread and
    // item rows keep the case the relay needs.
    var common = {
      mondayItemId: created.itemId, mailbox: ctx.mailbox,
      threadId: msg.threadId,
      headerMessageId: ctx.rawMessageId || ctx.headerMessageId,
      gmailMessageId: ctx.candidate.mid, boardId: d.targetBoardId,
      subject: msg.subject, createdAt: ctx.now()
    };
    deps.ledger.stageMessage(common);
    deps.ledger.stageThreadAnchor(common);
    deps.ledger.stageItemIndex(common);
    deps.ledger.stageParticipants({
      threadId: msg.threadId, mondayItemId: created.itemId, mailbox: ctx.mailbox,
      gmailMessageId: ctx.candidate.mid, boardId: d.targetBoardId,
      subject: msg.subject, createdAt: ctx.now(),
      participants: collectParticipants(msg.from, msg.to, msg.cc)
    });
    summary.created++;

  } else if (d.classification === 'append-to-existing-item') {
    w.appendUpdate({
      itemId: d.anchorItemId,
      // gmailMessageId is REQUIRED here: attachment bytes are fetched by message
      // id, and without it every attachment on a reply fails to upload.
      gmailMessageId: ctx.candidate.mid,
      from: msg.from,
      senderEmail: msg.senderEmail,
      bodyHtml: msg.bodyHtml,
      bodyText: msg.bodyText,
      bodyError: msg.bodyError,
      attachments: msg.attachments || [],
      internalDate: msg.internalDate
    });
    deps.ledger.stageMessage({
      mondayItemId: d.anchorItemId, mailbox: ctx.mailbox,
      threadId: msg.threadId, headerMessageId: ctx.headerMessageId,
      gmailMessageId: ctx.candidate.mid, boardId: d.targetBoardId,
      subject: msg.subject, createdAt: ctx.now()
    });
    // Refresh the participant list. A reply is the moment somebody is added to
    // or dropped from a conversation, so this is the cheapest place to keep it
    // current — no extra Gmail call, the message is already fetched.
    deps.ledger.stageParticipants({
      threadId: msg.threadId, mondayItemId: d.anchorItemId, mailbox: ctx.mailbox,
      gmailMessageId: ctx.candidate.mid, boardId: d.targetBoardId,
      subject: msg.subject, createdAt: ctx.now(),
      participants: collectParticipants(msg.from, msg.to, msg.cc)
    });
    summary.appended++;

  } else {
    // Everything else is a decision NOT to act. Record the message so the same
    // decision is not recomputed forever — except for transient failures, where
    // recording it would permanently suppress a message that might succeed next
    // time.
    if (d.classification !== 'skipped-fetch-failed') {
      deps.ledger.stageMessage({
        mondayItemId: '', mailbox: ctx.mailbox,
        threadId: msg.threadId, headerMessageId: ctx.headerMessageId,
        gmailMessageId: ctx.candidate.mid, boardId: '',
        subject: msg.subject, createdAt: ctx.now(),
        source: 'apps-script:' + d.classification
      });
    }
    summary.skipped++;
  }
}

// ==========================================================================
// 70_GmailService.gs
// ==========================================================================

/**
 * Gmail wrapper — the only file that touches the Gmail advanced service.
 *
 * Runs AS THE SIGNED-IN USER. There is no service account, no JWT signing, no
 * domain-wide delegation and no token cache, because a per-user script reads its
 * own mailbox with its own OAuth grant. That deletes the entire auth layer the
 * Make implementation needed — along with the private key that had to be kept
 * out of every document.
 *
 * Thin by design: no branching that isn't about the shape of Google's response.
 * Anything resembling a decision belongs in a tested file.
 */

function createGmailService() {

  function header(payload, name) {
    var hs = (payload && payload.headers) || [];
    var want = String(name).toLowerCase();
    for (var i = 0; i < hs.length; i++) {
      if (String(hs[i].name).toLowerCase() === want) { return hs[i].value || ''; }
    }
    return '';
  }

  function firstAddress(v) {
    var m = String(v || '').match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
    return m ? m[0].toLowerCase() : '';
  }

  /**
   * Turn whatever the advanced Gmail service hands back for a `format: byte`
   * field (body.data, attachment.data) into BYTES.
   *
   * WHY THIS IS NOT JUST base64DecodeWebSafe():
   * On 18 Aug every single body part failed with "Could not decode string." from
   * BOTH decoders — web-safe AND standard. A string that is valid base64url
   * fails the standard alphabet; a string that is valid standard base64 fails the
   * web-safe one. Failing BOTH means the value was never a base64 string at all.
   * The advanced service does not reliably hand back the raw encoded string, so
   * this dispatches on the actual shape instead of assuming one.
   *
   * Returns {bytes, text, error} — text is only set when we took the
   * already-plain-text path. NEVER returns empty with the reason discarded.
   */
  function decodeGmailData(data) {
    if (data === null || data === undefined || data === '') {
      return { bytes: null, text: '', error: '' };
    }
    var errs = [];

    // SHAPE 1 — already decoded to bytes (Byte[] / array of numbers).
    if (typeof data !== 'string') {
      try {
        return { bytes: Utilities.newBlob(data).getBytes(), text: '', error: '' };
      } catch (e0) {
        errs.push('bytes: ' + (e0 && e0.message));
      }
      // A non-string that is not blob-able: stringify and carry on below, but
      // record the shape so the next failure is diagnosable rather than mystifying.
      errs.push('shape: ' + Object.prototype.toString.call(data));
    }

    var str = String(data);

    // SHAPE 2 — already decoded to TEXT. Anything outside the base64 alphabet
    // proves it was never encoded, and handing it to a decoder only produces
    // "Could not decode string."
    if (!looksLikeBase64(str)) {
      return { bytes: null, text: str, error: '' };
    }

    // SHAPE 3 — an encoded string. base64url first (what the API documents),
    // then the standard alphabet.
    try {
      return { bytes: Utilities.base64DecodeWebSafe(padBase64(str)), text: '', error: '' };
    } catch (e1) { errs.push('websafe: ' + (e1 && e1.message)); }
    try {
      return { bytes: Utilities.base64Decode(toStandardBase64(str)), text: '', error: '' };
    } catch (e2) { errs.push('standard: ' + (e2 && e2.message)); }

    return { bytes: null, text: '', error: errs.join(' | ') };
  }

  /** Body part -> {text, error}. See decodeGmailData for why this is not one line. */
  function decodePart(data) {
    var d = decodeGmailData(data);
    if (d.text) { return { text: d.text, error: '' }; }
    if (d.bytes) {
      try {
        return { text: Utilities.newBlob(d.bytes).getDataAsString(), error: '' };
      } catch (e) {
        return { text: '', error: 'blob: ' + (e && e.message) };
      }
    }
    return { text: '', error: d.error };
  }

  return {
    getProfileEmail: function () {
      return Gmail.Users.getProfile('me').emailAddress;
    },

    /** Newest historyId — used to seed a first run without backfilling. */
    currentHistoryId: function () {
      return String(Gmail.Users.getProfile('me').historyId);
    },

    /**
     * Everything that changed since the cursor. `historyTypes` is deliberately
     * NOT narrowed: we need both messageAdded and labelAdded, and the extractor
     * decides what matters.
     */
    historyList: function (startHistoryId, pageToken) {
      var params = { startHistoryId: String(startHistoryId) };
      if (pageToken) { params.pageToken = pageToken; }
      return Gmail.Users.History.list('me', params);
    },

    /** {labelMap, userLabelMap} — user labels are the ones matched to boards. */
    labelsList: function () {
      var res = Gmail.Users.Labels.list('me');
      var labelMap = {};
      var userLabelMap = {};
      ((res && res.labels) || []).forEach(function (l) {
        labelMap[l.id] = l.name;
        if (l.type === 'user') { userLabelMap[l.id] = l.name; }
      });
      return { labelMap: labelMap, userLabelMap: userLabelMap };
    },

    /**
     * Metadata plus the parts needed to build the monday item and its update.
     * `format: 'full'` so the body and attachment ids come back in one call —
     * in Apps Script an extra API call is free, unlike Make where each was a
     * billed operation.
     */
    messagesGet: function (id) {
      var msg;
      try {
        msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
      } catch (e) {
        return { ok: false, gmailMessageId: id, threadId: '', labelIds: [], error: String(e && e.message) };
      }
      var payload = msg.payload || {};
      var from = header(payload, 'From');

      var attachments = [];
      (function walk(part) {
        if (!part) { return; }
        if (part.filename && part.body && part.body.attachmentId) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType,
            attachmentId: part.body.attachmentId,
            size: part.body.size
          });
        }
        (part.parts || []).forEach(walk);
      })(payload);

      // The whole body walk is best-effort. Headers are what the classifier
      // needs; the body only enriches the monday item.
      var bodyHtml = '';
      var bodyText = '';
      var bodyErrors = [];
      try {
        (function findBody(part) {
          if (!part) { return; }
          var mime = part.mimeType || '';
          var isText = (mime === 'text/html' || mime === 'text/plain');
          var b = part.body || {};

          if (isText && !part.filename) {
            var raw = b.data;

            // OVERSIZED BODIES ARRIVE AS AN ATTACHMENT, NOT INLINE.
            // Above a size threshold Gmail omits `data` and returns an
            // attachmentId with no filename — so it is invisible to a walker
            // that only reads `data`, and invisible to the attachment collector
            // too, which requires a filename. A large marketing email therefore
            // produced an item with no body at all (18 Aug). Fetch it.
            if (!raw && b.attachmentId) {
              try {
                raw = Gmail.Users.Messages.Attachments.get('me', id, b.attachmentId).data;
              } catch (e) {
                bodyErrors.push(mime + ' body part fetch failed: ' + (e && e.message));
              }
            }

            if (raw) {
              var d = decodePart(raw);
              if (d.text) {
                if (mime === 'text/html' && !bodyHtml) { bodyHtml = d.text; }
                else if (mime === 'text/plain' && !bodyText) { bodyText = d.text; }
              } else if (d.error) {
                bodyErrors.push(mime + ' — ' + d.error);
              }
            }
          }
          (part.parts || []).forEach(findBody);
        })(payload);
      } catch (e) {
        bodyErrors.push('body walk failed: ' + String(e && e.message));
      }
      // Only report an error when we actually ended up with nothing usable.
      var bodyError = (bodyHtml || bodyText) ? '' : bodyErrors.join('; ');

      return {
        ok: true,
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        labelIds: msg.labelIds || [],
        headerMessageId: header(payload, 'Message-ID'),
        references: header(payload, 'References'),
        inReplyTo: header(payload, 'In-Reply-To'),
        from: from,
        senderEmail: firstAddress(from),
        to: header(payload, 'To'),
        cc: header(payload, 'Cc'),
        subject: header(payload, 'Subject'),
        syncOrigin: header(payload, SYNC_HEADER_NAME),
        internalDate: msg.internalDate,
        bodyHtml: bodyHtml,
        bodyText: bodyText,
        bodyError: bodyError,
        attachments: attachments
      };
    },

    /**
     * Every From/To/Cc value across a thread, for building a reply's recipient
     * list. Read LIVE rather than from the ledger: people join a thread after a
     * project is created, and a stored list would quietly cut them out.
     */
    threadAddresses: function (threadId) {
      var res = Gmail.Users.Threads.get('me', threadId, {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc']
      });
      var out = [];
      ((res && res.messages) || []).forEach(function (m) {
        var hs = (m.payload && m.payload.headers) || [];
        hs.forEach(function (h) {
          var n = String(h.name).toLowerCase();
          if (n === 'from' || n === 'to' || n === 'cc') { out.push(h.value || ''); }
        });
      });
      return out;
    },

    /**
     * Send a prepared RFC 2822 message INTO an existing thread.
     *
     * threadId makes Gmail file it in our own thread; the In-Reply-To and
     * References headers in the raw message are what make it thread correctly in
     * the RECIPIENT's client. Both are required — neither alone is enough.
     */
    sendRaw: function (raw, threadId) {
      var res = Gmail.Users.Messages.send({
        raw: Utilities.base64EncodeWebSafe(raw).replace(/=+$/, ''),
        threadId: String(threadId)
      }, 'me');
      return String((res && res.id) || '');
    },

    /**
     * Attachment bytes, fetched lazily — only when something will be uploaded.
     * Goes through the SAME shape dispatch as the body: attachment.data is the
     * same `format: byte` field and was failing the same way, which is the most
     * likely reason the first live test uploaded no files.
     */
    attachmentBlob: function (messageId, att) {
      var a = Gmail.Users.Messages.Attachments.get('me', messageId, att.attachmentId);
      var d = decodeGmailData(a.data);
      if (d.bytes) { return Utilities.newBlob(d.bytes, att.mimeType, att.filename); }
      if (d.text) { return Utilities.newBlob(d.text, att.mimeType, att.filename); }
      throw new Error('could not decode attachment ' + att.filename + ': ' + d.error);
    }
  };
}

/**
 * READ-ONLY body probe. Writes nothing to monday, moves no cursor, touches no
 * ledger. Run it from the editor with a Gmail message id.
 *
 * Prints the RAW SHAPE of body.data before any decoding is attempted. That is
 * the question two rounds of decoder fixes failed to ask: I assumed the value
 * was a base64 string and kept changing how it was decoded, when both decoders
 * failing on the same value meant it was never a base64 string.
 */
var PROBE_MESSAGE_ID = '';

function probeBody() {
  var id = String(PROBE_MESSAGE_ID || '').trim();
  if (!id) {
    console.log('Set PROBE_MESSAGE_ID at the top of 70_GmailService.gs first.');
    console.log('Take it from the "Gmail Message ID" column on the monday item.');
    return;
  }

  var raw;
  try {
    raw = Gmail.Users.Messages.get('me', id, { format: 'full' });
  } catch (e) {
    console.log('FETCH FAILED: ' + (e && e.message));
    return;
  }

  console.log('=== RAW PART SHAPES ===');
  (function walk(part, path) {
    if (!part) { return; }
    var b = part.body || {};
    var d = b.data;
    if (d !== null && d !== undefined && d !== '') {
      var kind = typeof d;
      var tag = Object.prototype.toString.call(d);
      var len = (d && d.length !== undefined) ? d.length : '?';
      console.log(path + ' [' + (part.mimeType || '?') + '] typeof=' + kind +
        ' tag=' + tag + ' len=' + len +
        ' isArray=' + (Object.prototype.toString.call(d) === '[object Array]'));
      console.log('   String(data).slice(0,120): ' + String(d).slice(0, 120));
      console.log('   looksLikeBase64: ' + looksLikeBase64(String(d)));
    } else if (b.attachmentId && !part.filename) {
      console.log(path + ' [' + (part.mimeType || '?') +
        '] NO INLINE DATA — oversized part, attachmentId ' + b.attachmentId);
    }
    (part.parts || []).forEach(function (p, i) { walk(p, path + '.' + i); });
  })(raw.payload, 'payload');

  console.log('');
  console.log('=== WHAT THE SERVICE PRODUCES ===');
  var m = createGmailService().messagesGet(id);
  if (!m.ok) { console.log('FETCH FAILED: ' + m.error); return; }
  console.log('subject   : ' + m.subject);
  console.log('from      : ' + m.from);
  console.log('html body : ' + (m.bodyHtml ? m.bodyHtml.length + ' chars' : 'EMPTY'));
  console.log('text body : ' + (m.bodyText ? m.bodyText.length + ' chars' : 'EMPTY'));
  console.log('bodyError : ' + (m.bodyError || '(none)'));
  console.log('files     : ' + m.attachments.length);
  console.log('--- first 300 chars ---');
  console.log((m.bodyText || m.bodyHtml || '').slice(0, 300) || '(nothing)');
}

// ==========================================================================
// 80_MondayClient.gs
// ==========================================================================

/**
 * monday.com client.
 *
 * Only the CENTRAL WEB APP holds the API token, so this file is loaded by the
 * Web App deployment (running as msalvana@group247ww.com) and not by the
 * per-user scripts. The user scripts reach monday through the Web App instead,
 * which is what keeps four other people from holding an admin token.
 */

/**
 * monday API version.
 *
 * DELIBERATELY UNPINNED (empty = the account's current default).
 *
 * This was pinned to '2024-10', where `original_creation_date` does not exist on
 * `create_update`. Every update failed with `Unknown argument
 * "original_creation_date"` — the item was created, the email was not attached,
 * and replies dead-lettered. Verified live on 18 Aug from the run log.
 *
 * A pinned version is normally the safer choice, but only if you also verify the
 * pin supports what you call. This one did not. The queries here are basic and
 * stable, and createUpdate falls back to an undated post if the field is ever
 * unavailable again, so the default version plus that fallback is more robust
 * than a pin nobody re-checks.
 *
 * If you do pin it, set a version and then re-run a create and a reply.
 */
var MONDAY_API_VERSION = '';

function createMondayClient(token) {
  var ENDPOINT = 'https://api.monday.com/v2';
  var lastUpdateWasBackdated = true;
  var lastUpdateDateError = '';

  function gql(query, variables) {
    var res = UrlFetchApp.fetch(ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: MONDAY_API_VERSION
        ? { Authorization: token, 'API-Version': MONDAY_API_VERSION }
        : { Authorization: token },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body = res.getContentText();
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      throw new Error('monday returned non-JSON (HTTP ' + code + '): ' + body.slice(0, 300));
    }
    // monday answers HTTP 200 with an `errors` array, so the status code alone
    // is not a success check. Missing this is how a "successful" run writes
    // nothing — the exact shape of failure that hid a 401 for two hours in Make.
    if (code >= 400 || parsed.errors || parsed.error_message) {
      throw new Error('monday error (HTTP ' + code + '): ' +
        JSON.stringify(parsed.errors || parsed.error_message).slice(0, 500));
    }
    return parsed.data;
  }

  return {
    gql: gql,

    /**
     * {lowercased board name: {id, name}} across ALL boards.
     *
     * PAGINATED DELIBERATELY. The Make version used `boards(limit: 100)` with no
     * paging; G247 has 47 active boards today and created a dozen in one week.
     * At 100 that query silently truncates and a valid label whose board fell
     * off the page just never matches — no error, nothing happens.
     */
    boardNameMap: function () {
      var map = {};
      var page = 1;
      var guard = 0;
      while (guard++ < 50) {
        var data = gql(
          'query($page:Int!){ boards(limit:100, page:$page, state:active){ id name } }',
          { page: page }
        );
        var boards = (data && data.boards) || [];
        boards.forEach(function (b) {
          // Subitem boards are returned like any other and must never be a
          // label target. See isProjectBoard() for why board_kind can't be used.
          if (!isProjectBoard(b.name)) { return; }
          map[String(b.name || '').trim().toLowerCase()] = { id: String(b.id), name: b.name };
        });
        if (boards.length < 100) { break; }
        page++;
      }
      return map;
    },

    /**
     * The newest updates across the whole account, newest first.
     *
     * ONE call per run, whatever the number of boards — which is why the
     * outbound bridge needs no webhook and no per-board setup. Make's version
     * was a webhook bound to a single board id and would have needed
     * registering 28 times, then again for every new board.
     */
    recentUpdates: function (limit) {
      var data = gql(
        'query($limit:Int!){ updates(limit:$limit){ id created_at creator_id item_id text_body } }',
        { limit: Number(limit) || 25 }
      );
      return ((data && data.updates) || []).map(function (u) {
        return {
          id: String(u.id),
          createdAt: u.created_at,
          creatorId: String(u.creator_id || ''),
          itemId: String(u.item_id || ''),
          textBody: u.text_body || ''
        };
      });
    },

    /** Column ids present on a board — drives write-what-exists. */
    boardColumnIds: function (boardId) {
      var data = gql('query($id:[ID!]){ boards(ids:$id){ columns{ id } } }', { id: [String(boardId)] });
      var b = data && data.boards && data.boards[0];
      return ((b && b.columns) || []).map(function (c) { return c.id; });
    },

    /** Contacts lookup by email. Returns '' when unmatched — never creates. */
    findContactByEmail: function (email) {
      if (!email) { return ''; }
      var data = gql(
        'query($board:ID!,$col:String!,$val:String!){' +
        ' items_page_by_column_values(board_id:$board, limit:1,' +
        '  columns:[{column_id:$col, column_values:[$val]}]){ items{ id } } }',
        { board: CONTACTS_BOARD_ID, col: CONTACTS_EMAIL_COLUMN, val: String(email).toLowerCase() }
      );
      var items = data && data.items_page_by_column_values && data.items_page_by_column_values.items;
      return (items && items.length) ? String(items[0].id) : '';
    },

    /**
     * NOTE: `create_labels_if_missing` is deliberately NOT set.
     *
     * It only matters when writing a status/dropdown value whose label does not
     * yet exist on the board — and buildColumnValues never writes one. The flag
     * requires board-settings permission, so on any of the 47 boards you do not
     * own it could turn a working create into a hard failure. All risk, no
     * benefit. If a status column is ever added to the mapping, revisit this
     * together with who owns the target boards.
     */
    createItem: function (boardId, groupId, itemName, columnValues) {
      var data = gql(
        'mutation($board:ID!,$group:String,$name:String!,$cols:JSON){' +
        ' create_item(board_id:$board, group_id:$group, item_name:$name,' +
        '  column_values:$cols){ id } }',
        { board: String(boardId), group: groupId || null, name: itemName, cols: JSON.stringify(columnValues || {}) }
      );
      return String(data.create_item.id);
    },

    /**
     * Post an update, backdated to the email where possible.
     *
     * FALLS BACK. `original_creation_date` is the newest and least essential part
     * of this call — it can fail on API version, permission or date format, and
     * losing the email over a timestamp would be a terrible trade. So a failure
     * with the date is retried immediately without it. Which path ran is
     * returned, so a silently un-backdated update is still visible in the log.
     */
    createUpdate: function (itemId, bodyHtml, originalCreationDate) {
      function post(withDate) {
        var vars = { item: String(itemId), body: bodyHtml };
        var q = 'mutation($item:ID!,$body:String!' +
          (withDate ? ',$when:String' : '') + '){' +
          ' create_update(item_id:$item, body:$body' +
          (withDate ? ', original_creation_date:$when' : '') + '){ id } }';
        if (withDate) { vars.when = originalCreationDate; }
        var data = gql(q, vars);
        if (!data || !data.create_update || !data.create_update.id) {
          throw new Error('create_update returned no id: ' + JSON.stringify(data).slice(0, 300));
        }
        return String(data.create_update.id);
      }

      if (!originalCreationDate) { return post(false); }
      try {
        return post(true);
      } catch (e) {
        // Retry undated. If THIS throws it is a real failure and must surface.
        var id = post(false);
        lastUpdateWasBackdated = false;
        lastUpdateDateError = String((e && e.message) || e).slice(0, 300);
        return id;
      }
    },

    /** Diagnostics for the last createUpdate call. */
    lastUpdateBackdated: function () { return lastUpdateWasBackdated; },
    lastUpdateDateError: function () { return lastUpdateDateError; },

    /** Multipart upload — the file API is not plain GraphQL over JSON. */
    addFileToUpdate: function (updateId, blob) {
      var query = 'mutation($file: File!, $update: ID!) { add_file_to_update(update_id: $update, file: $file) { id } }';
      var res = UrlFetchApp.fetch('https://api.monday.com/v2/file', {
        method: 'post',
        headers: { Authorization: token },
        payload: {
          query: query,
          variables: JSON.stringify({ update: String(updateId), file: null }),
          map: JSON.stringify({ image: 'variables.file' }),
          image: blob
        },
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var parsed;
      try { parsed = JSON.parse(res.getContentText()); } catch (e) { parsed = {}; }
      if (code >= 400 || parsed.errors) {
        throw new Error('monday file upload failed (HTTP ' + code + '): ' +
          JSON.stringify(parsed.errors || '').slice(0, 300));
      }
      return parsed.data && parsed.data.add_file_to_update && String(parsed.data.add_file_to_update.id);
    }
  };
}

// ==========================================================================
// 85_Writer.gs
// ==========================================================================

/**
 * The writer — everything that CHANGES monday.
 *
 * Both the monday client and the Gmail service are injected, so the whole thing
 * runs under Node with fakes. This is the last untested surface in the system and
 * the only part that can damage your boards, so it gets the same treatment as the
 * classifier: no direct service calls, no hidden state.
 *
 * ATTACHMENTS ARE BEST-EFFORT, DELIBERATELY.
 * A file that fails to upload must never cost the item or the update. The email
 * is the record; the attachment is a convenience, and it is still one click away
 * in Gmail. Every skip is reported in the returned summary and logged — never
 * swallowed.
 */

/**
 * UrlFetch payloads and monday uploads both have limits, and one enormous
 * attachment should not take down a run. 20 MB is far above a normal brief and
 * far below anything that would break the request.
 */
var MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Does this monday error mean "that person is not on this board"?
 *
 * monday reports it as a ColumnValueException carrying
 * `column_validation_error_code: invalidPersonAssignment`. Matching on the code
 * rather than on prose, with a message fallback, because error text changes and
 * a missed match here costs the whole project item.
 */
function isPersonAssignmentError(e) {
  var m = String((e && e.message) || e || '');
  if (!m) { return false; }
  if (m.indexOf('invalidPersonAssignment') !== -1) { return true; }
  return /unable to assign person/i.test(m);
}

/**
 * @param {Object} monday from createMondayClient()
 * @param {Object} gmail  from createGmailService() — needed for attachment bytes
 * @param {Object} [log]  from createRunLog()
 */
function createWriter(monday, gmail, log) {
  var columnCache = {};   // boardId -> [columnId]; one lookup per board per run

  function boardColumns(boardId) {
    if (!columnCache[boardId]) { columnCache[boardId] = monday.boardColumnIds(boardId); }
    return columnCache[boardId];
  }

  function note(level, stage, fields) {
    if (log && log[level]) { log[level](stage, fields); }
  }

  /**
   * Upload each attachment to an update. Returns what happened per file.
   * Never throws: see the note at the top of this file.
   */
  function uploadAttachments(updateId, gmailMessageId, attachments) {
    var result = { uploaded: 0, skipped: [] };
    (attachments || []).forEach(function (att) {
      try {
        if (att.size && Number(att.size) > MAX_ATTACHMENT_BYTES) {
          result.skipped.push(att.filename + ' (too large: ' + att.size + ' bytes)');
          return;
        }
        var blob = gmail.attachmentBlob(gmailMessageId, att);
        monday.addFileToUpdate(updateId, blob);
        result.uploaded++;
      } catch (e) {
        result.skipped.push(att.filename + ' (' + String(e && e.message).slice(0, 120) + ')');
      }
    });
    if (result.skipped.length) {
      note('warn', 'attachment', {
        gmailMessageId: gmailMessageId, itemId: '',
        detail: 'skipped ' + result.skipped.length + ': ' + result.skipped.join('; ')
      });
    }
    return result;
  }

  /**
   * Resolve the sender to a Contacts row. Returns '' when unmatched — by
   * decision, we never auto-create contacts, so the 123-row Contacts board stays
   * curated instead of filling with mailing lists and typo'd addresses. The
   * address still lands in C. Email either way.
   */
  function resolveContact(senderEmail) {
    if (!senderEmail || AUTO_CREATE_CONTACTS) { return ''; }
    try {
      return monday.findContactByEmail(senderEmail);
    } catch (e) {
      note('warn', 'contact', { detail: 'contact lookup failed for ' + senderEmail + ': ' + (e && e.message) });
      return '';
    }
  }

  return {
    /**
     * Create the project item, post the email as its first update, attach files.
     * The ITEM is what must exist; everything after it is enrichment and is
     * allowed to fail without losing the project.
     */
    createProject: function (a) {
      var cols = boardColumns(a.boardId);
      var contactId = resolveContact(a.senderEmail);

      var built = buildColumnValues(cols, {
        mailbox: a.mailbox,
        senderEmail: a.senderEmail,
        contactItemId: contactId,
        threadId: a.threadId,
        headerMessageId: a.headerMessageId,
        nowIso: a.nowIso,
        syncMessage: 'created from Gmail message ' + (a.gmailMessageId || ''),
        syncStatus: ''   // left unset: an unknown status label errors on boards
                         // that do not define it, and it earns us nothing
      });

      var itemId;
      var pmDropped = '';
      try {
        itemId = monday.createItem(a.boardId, a.groupId, a.itemName, built.columnValues);
      } catch (e) {
        // INVALID PERSON ASSIGNMENT.
        // monday refuses to assign a person to a People column unless that
        // person is a subscriber of the board. This already happened in
        // production under Make ("unable to assign person with id: 69705587").
        // Losing the whole project over the PM stamp is the wrong trade: drop
        // that one column, keep everything else, and say so loudly.
        if (!isPersonAssignmentError(e) || !built.columnValues[COLUMNS.g247pm]) { throw e; }
        var retry = {};
        Object.keys(built.columnValues).forEach(function (k) {
          if (k !== COLUMNS.g247pm) { retry[k] = built.columnValues[k]; }
        });
        itemId = monday.createItem(a.boardId, a.groupId, a.itemName, retry);
        pmDropped = String((e && e.message) || e).slice(0, 200);
        built.written = built.written.filter(function (w) { return w !== 'G247 PM'; });
        built.skipped.push('G247 PM (person not a subscriber of board ' + a.boardId + ')');
        note('warn', 'create', {
          itemId: itemId, boardId: a.boardId, gmailMessageId: a.gmailMessageId,
          detail: 'G247 PM NOT SET — add ' + a.mailbox + ' as a subscriber of this board, ' +
            'then set the column by hand. monday said: ' + pmDropped
        });
      }

      note('info', 'create', {
        itemId: itemId, boardId: a.boardId, gmailMessageId: a.gmailMessageId,
        detail: 'wrote [' + built.written.join(', ') + ']' +
          (built.skipped.length ? '; skipped [' + built.skipped.join(', ') + ']' : '') +
          (contactId ? '; contact ' + contactId : '; contact unmatched')
      });

      var updateId = '';
      var attach = { uploaded: 0, skipped: [] };
      try {
        updateId = monday.createUpdate(itemId, formatUpdateBody(a), toMondayDateTime(a.internalDate));
        if (monday.lastUpdateBackdated && !monday.lastUpdateBackdated()) {
          note('warn', 'create-update', {
            itemId: itemId, gmailMessageId: a.gmailMessageId,
            detail: 'update posted WITHOUT backdating: ' +
              (monday.lastUpdateDateError ? monday.lastUpdateDateError() : '')
          });
        }
        attach = uploadAttachments(updateId, a.gmailMessageId, a.attachments);
      } catch (e) {
        // The project exists. Losing its first update is bad but recoverable;
        // throwing here would dead-letter a message whose item was created,
        // and the next run would create a SECOND item for the same email.
        note('error', 'create-update', {
          itemId: itemId, gmailMessageId: a.gmailMessageId,
          detail: 'item created but first update failed: ' + (e && e.message)
        });
      }

      return { itemId: itemId, updateId: updateId, attachments: attach, columns: built, pmDropped: pmDropped };
    },

    /** Append one email to an existing item as an update. */
    appendUpdate: function (a) {
      var updateId = monday.createUpdate(a.itemId, formatUpdateBody(a), toMondayDateTime(a.internalDate));
      var attach = uploadAttachments(updateId, a.gmailMessageId, a.attachments);
      note('info', 'append', {
        itemId: a.itemId, gmailMessageId: a.gmailMessageId,
        detail: 'update ' + updateId + '; ' + attach.uploaded + ' file(s)'
      });
      return { updateId: updateId, attachments: attach };
    },

    /**
     * A human-visible queue for anything monday rejected. Its own board, its own
     * columns, and it must never throw — a failure to record a failure would
     * lose the only trace that something went wrong.
     */
    deadLetter: function (a) {
      try {
        var cv = {};
        cv[DEADLETTER_COLUMNS.gmailMessageId] = String(a.gmailMessageId || '');
        cv[DEADLETTER_COLUMNS.gmailThreadId] = String(a.threadId || '');
        cv[DEADLETTER_COLUMNS.error] = String(a.error || '').slice(0, 1000);
        cv[DEADLETTER_COLUMNS.mailbox] = String(a.mailbox || '');
        cv[DEADLETTER_COLUMNS.targetBoard] = String(a.targetBoard || '');
        if (a.failedAt) {
          cv[DEADLETTER_COLUMNS.failedAt] = { date: String(a.failedAt).slice(0, 10) };
        }
        var name = 'Gmail sync failed: ' + String(a.gmailMessageId || 'unknown');
        var itemId = monday.createItem(DEADLETTER_BOARD_ID, null, name, cv);
        note('warn', 'deadletter', { itemId: itemId, gmailMessageId: a.gmailMessageId, detail: a.error });
        return { itemId: itemId };
      } catch (e) {
        note('error', 'deadletter', {
          gmailMessageId: a.gmailMessageId,
          detail: 'DEAD-LETTER WRITE FAILED: ' + (e && e.message) + ' || original error: ' + a.error
        });
        return { itemId: '' };
      }
    }
  };
}

// ==========================================================================
// 88_Outbound.gs
// ==========================================================================

/**
 * OUTBOUND BRIDGE — monday update -> reply into the Gmail thread.
 *
 * Ported from Make scenario 4862180, with three deliberate changes. Read these
 * before altering anything here: each one exists because the Make version would
 * have caused real damage under the current setup.
 *
 * 1. OPT-IN, NOT OPT-OUT.
 *    Make mirrored every update that the integration user did not write. Most
 *    updates on a G247 board are internal — a tracker link, a file for review,
 *    a colleague asking about our own IP. Default-send would mail those to the
 *    client. Here an update is mirrored ONLY if it opens with OUTBOUND_MARKER.
 *
 * 2. THE LOOP GUARD CHECKS EVERY INTEGRATION IDENTITY.
 *    Make's filter was `userId != 37824531` — David alone. The intake now writes
 *    as Mark (78417174), so under Make's rule every inbound email would have been
 *    mailed straight back to the client who sent it. We check the whole list.
 *
 * 3. RECORD BEFORE SEND — THE INVERSE OF THE INTAKE'S RULE.
 *    The intake flushes the ledger before advancing its cursor, so a crash
 *    reprocesses rather than skips. Here the failure costs an EMAIL, and a
 *    duplicate email cannot be recalled while a missing one can be re-sent by
 *    hand. So the ledger row is written FIRST. If the send then fails we lose
 *    one mirror, loudly, instead of risking two copies at a client.
 */

/** An update is mirrored only if its text starts with this. Case-insensitive. */
var OUTBOUND_MARKER = '[client]';

/** off = nothing sent. self = sent to the mailbox owner only. thread = real. */
var PROP_BRIDGE_MODE = 'G247_BRIDGE_MODE';
var PROP_BRIDGE_RATE = 'G247_BRIDGE_RATE';
var OUTBOUND_CURSOR_KEY = 'outboundCursor';

/**
 * Unset means OFF. An absent property must never be the thing that starts
 * sending mail to clients; turning this on has to be a deliberate act.
 */
var DEFAULT_BRIDGE_MODE = 'off';

/** Circuit breaker, ported from Make: at most this many sends per hour. */
var OUTBOUND_MAX_PER_HOUR = 20;
var OUTBOUND_WINDOW_MS = 60 * 60 * 1000;

/** How many recent updates to look at per run. One monday call. */
var OUTBOUND_POLL_LIMIT = 25;

/** Addresses that must never receive a mirrored update. */
var OUTBOUND_BLOCKED = ['noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notifications@monday.com', 'mailer-daemon', 'bounce'];

var SYNC_HEADER_VALUE = 'monday-bridge';

/** Does this update text opt in? Returns {mirror, body} with the marker removed. */
function parseOutboundMarker(text) {
  var s = String(text === null || text === undefined ? '' : text);
  var lead = s.replace(/^[\s ]+/, '');
  if (lead.slice(0, OUTBOUND_MARKER.length).toLowerCase() !== OUTBOUND_MARKER) {
    return { mirror: false, body: '' };
  }
  return { mirror: true, body: lead.slice(OUTBOUND_MARKER.length).replace(/^[\s ]+/, '') };
}

/**
 * Should this update be mirrored, and why not when it should not?
 * PURE — every input is passed in, so every branch is testable without a token.
 *
 * @param {Object} u      {id, creatorId, itemId, textBody, htmlBody}
 * @param {Object} ctx    {mode, mailbox, anchor, alreadySent, integrationIds}
 * @return {{send:boolean, reason:string, body:string}}
 */
function shouldMirrorUpdate(u, ctx) {
  u = u || {};
  ctx = ctx || {};
  var mode = String(ctx.mode || DEFAULT_BRIDGE_MODE).toLowerCase();
  if (mode !== 'self' && mode !== 'thread') {
    return { send: false, reason: 'bridge-mode=' + mode, body: '' };
  }

  // Loop guard first: our own writes must never be mirrored, marker or not.
  // An intake-posted email body could easily begin with the marker by accident.
  var ids = ctx.integrationIds || [];
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i]) === String(u.creatorId)) {
      return { send: false, reason: 'written-by-integration-user', body: '' };
    }
  }

  if (ctx.alreadySent) { return { send: false, reason: 'already-mirrored', body: '' }; }

  var marked = parseOutboundMarker(u.textBody);
  if (!marked.mirror) { return { send: false, reason: 'no-marker', body: '' }; }
  if (!marked.body) { return { send: false, reason: 'empty-after-marker', body: '' }; }

  var a = ctx.anchor;
  if (!a || !a.threadId || !a.headerMessageId) {
    return { send: false, reason: 'no-gmail-thread-for-item', body: '' };
  }

  // Sharding: exactly one of the five mailboxes owns each thread, and only that
  // one can send from the right address. Everyone else must leave it alone.
  if (String(a.mailbox || '').toLowerCase() !== String(ctx.mailbox || '').toLowerCase()) {
    return { send: false, reason: 'not-this-mailbox', body: '' };
  }

  return { send: true, reason: 'ok', body: marked.body };
}

/**
 * Recipients for a mirrored update, from the LIVE thread headers rather than
 * anything stored — people get added to a thread after a project is created,
 * and a stale stored list would quietly cut them out.
 * PURE.
 */
function outboundRecipients(headerValues, selfAddress, mode) {
  if (String(mode).toLowerCase() === 'self') { return [String(selfAddress || '')]; }
  var seen = {};
  var out = [];
  var me = String(selfAddress || '').toLowerCase();
  (headerValues || []).forEach(function (v) {
    String(v || '').split(',').forEach(function (part) {
      var m = String(part).match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
      if (!m) { return; }
      var addr = m[0].toLowerCase();
      if (addr === me || seen[addr]) { return; }
      for (var b = 0; b < OUTBOUND_BLOCKED.length; b++) {
        if (addr.indexOf(OUTBOUND_BLOCKED[b]) !== -1) { return; }
      }
      seen[addr] = true;
      out.push(addr);
    });
  });
  return out;
}

/** RFC 2047 for a non-ASCII subject; plain text otherwise. PURE. */
function encodeSubject(subject, b64) {
  var s = String(subject || '');
  if (/^[\x20-\x7e]*$/.test(s)) { return s; }
  return '=?UTF-8?B?' + b64(s) + '?=';
}

/** 'x' -> 'Re: x'; never 'Re: Re: x'. PURE. */
function replySubject(subject) {
  var s = String(subject || '').trim() || '(no subject)';
  return /^re:\s*/i.test(s) ? s : 'Re: ' + s;
}

/**
 * Build the RFC 2822 message. PURE — base64 is injected so this runs under Node.
 *
 * In-Reply-To AND References both carry the thread's ROOT Message-ID. Gmail
 * needs the threadId parameter too, but a mail client on the other end only has
 * these headers, so omitting them makes the reply start a new thread in the
 * client's inbox even though it looks correct in ours.
 */
function buildMirrorMime(a, b64) {
  var lines = [];
  lines.push('To: ' + (a.to || []).join(', '));
  lines.push('Subject: ' + encodeSubject(replySubject(a.subject), b64));
  var ref = '<' + String(a.headerMessageId || '').replace(/^<|>$/g, '') + '>';
  lines.push('In-Reply-To: ' + ref);
  lines.push('References: ' + ref);
  lines.push(SYNC_HEADER_NAME + ': ' + SYNC_HEADER_VALUE);
  lines.push('X-G247-Item: ' + (a.itemId || ''));
  lines.push('X-G247-Update: ' + (a.updateId || ''));
  lines.push('X-G247-Mode: ' + (a.mode || ''));
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('');
  lines.push(a.html || '');
  return lines.join('\r\n');
}

/** The footer exists so a recipient can tell where this came from. PURE. */
function mirrorHtml(body, a) {
  var esc = escapeHtml(body).replace(/\n/g, '<br>');
  return esc +
    '<br><br><span style="color:#888;font-size:12px">' +
    'Sent from monday item ' + escapeHtml(String(a.itemId || '')) +
    '</span>';
}

/**
 * Rolling-window send cap. Ported from Make (data store 90300, key
 * outbound-rate). State lives in Script Properties, so it is shared across all
 * five mailboxes — which is what we want for a global brake — but concurrent
 * runs can race it by a send or two. That is acceptable: this exists to stop a
 * runaway, not to be an exact meter. PURE apart from the store it is handed.
 */
function outboundRateGate(store, nowMs, limit, windowMs) {
  var raw = store.get(PROP_BRIDGE_RATE);
  var st;
  try { st = raw ? JSON.parse(raw) : null; } catch (e) { st = null; }
  if (!st || typeof st.windowStart !== 'number' || (nowMs - st.windowStart) >= windowMs) {
    st = { windowStart: nowMs, count: 0 };
  }
  if (st.count >= limit) {
    return { allow: false, count: st.count, commit: function () {} };
  }
  return {
    allow: true,
    count: st.count,
    commit: function () {
      st.count++;
      st.lastAt = nowMs;
      store.set(PROP_BRIDGE_RATE, JSON.stringify(st));
    }
  };
}

/**
 * One outbound pass. Every service is injected, so the whole thing — including
 * the send failure paths — runs under Node with fakes.
 *
 * @param {Object} deps {monday, gmail, ledger, state, props, log, now, nowMs, b64}
 * @param {Object} opts {dryRun}
 */
function runOutboundPass(deps, opts) {
  opts = opts || {};
  var summary = { mode: '', scanned: 0, sent: 0, skipped: 0, failed: 0, seeded: false, reasons: {} };
  var mode = String(deps.props.get(PROP_BRIDGE_MODE) || DEFAULT_BRIDGE_MODE).toLowerCase();
  summary.mode = mode;

  function note(reason) {
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
    summary.skipped++;
  }

  if (mode !== 'self' && mode !== 'thread') { return summary; }

  var updates = deps.monday.recentUpdates(OUTBOUND_POLL_LIMIT) || [];
  summary.scanned = updates.length;

  var cursor = deps.state.getCursor(OUTBOUND_CURSOR_KEY);

  // FIRST RUN SEEDS AND SENDS NOTHING. Without this the first pass would mail
  // every historical update carrying the marker. Same rule as the intake.
  if (!cursor) {
    var top = 0;
    updates.forEach(function (u) { top = Math.max(top, Number(u.id) || 0); });
    deps.state.setCursor(OUTBOUND_CURSOR_KEY, String(top));
    summary.seeded = true;
    deps.log.info('outbound-seed', { detail: 'cursor seeded at update ' + top + '; nothing sent' });
    return summary;
  }

  var mailbox = deps.gmail.getProfileEmail();
  var since = Number(cursor) || 0;
  var highest = since;

  // Oldest first, so a mid-run failure leaves the cursor behind the failure
  // rather than past it.
  var fresh = updates.filter(function (u) { return (Number(u.id) || 0) > since; })
                     .sort(function (x, y) { return (Number(x.id) || 0) - (Number(y.id) || 0); });

  for (var i = 0; i < fresh.length; i++) {
    var u = fresh[i];
    var anchor = deps.ledger.itemThread(u.itemId);
    var verdict = shouldMirrorUpdate(u, {
      mode: mode,
      mailbox: mailbox,
      anchor: anchor,
      alreadySent: deps.ledger.hasMirrored(u.id),
      integrationIds: INTEGRATION_USER_IDS
    });

    if (!verdict.send) {
      note(verdict.reason);
      highest = Math.max(highest, Number(u.id) || 0);
      continue;
    }

    var gate = outboundRateGate(deps.props, deps.nowMs(), OUTBOUND_MAX_PER_HOUR, OUTBOUND_WINDOW_MS);
    if (!gate.allow) {
      // Do NOT advance past it — try again in the next window.
      deps.log.warn('outbound-ratelimit', {
        itemId: u.itemId,
        detail: 'hit ' + OUTBOUND_MAX_PER_HOUR + '/hour cap; update ' + u.id + ' deferred'
      });
      break;
    }

    var to = outboundRecipients(deps.gmail.threadAddresses(anchor.threadId), mailbox, mode);
    if (!to.length) {
      note('no-safe-recipients');
      highest = Math.max(highest, Number(u.id) || 0);
      continue;
    }

    var raw = buildMirrorMime({
      to: to,
      subject: anchor.subject,
      headerMessageId: anchor.headerMessageId,
      itemId: u.itemId,
      updateId: u.id,
      mode: mode,
      html: mirrorHtml(verdict.body, { itemId: u.itemId })
    }, deps.b64);

    if (opts.dryRun) {
      deps.log.info('outbound-dryrun', {
        itemId: u.itemId, detail: 'would send to ' + to.join(', ') + ' (update ' + u.id + ')'
      });
      highest = Math.max(highest, Number(u.id) || 0);
      continue;
    }

    // RECORD BEFORE SEND — see the note at the top of this file.
    deps.ledger.stageMirrored({
      updateId: u.id, mondayItemId: u.itemId, mailbox: mailbox,
      threadId: anchor.threadId, headerMessageId: anchor.headerMessageId,
      subject: anchor.subject, createdAt: deps.now()
    });
    deps.ledger.flush();

    try {
      var sentId = deps.gmail.sendRaw(raw, anchor.threadId);
      gate.commit();
      summary.sent++;
      deps.log.info('outbound-sent', {
        itemId: u.itemId,
        detail: 'update ' + u.id + ' -> ' + to.join(', ') + ' (gmail ' + sentId + ', mode ' + mode + ')'
      });
    } catch (e) {
      summary.failed++;
      // The ledger row stays. A mirror that fails is lost on purpose rather than
      // retried, because a retry loop at a client's inbox is the worse outcome.
      deps.log.error('outbound-send', {
        itemId: u.itemId,
        detail: 'update ' + u.id + ' NOT sent and will not be retried: ' + (e && e.message)
      });
    }

    highest = Math.max(highest, Number(u.id) || 0);
  }

  if (highest > since) { deps.state.setCursor(OUTBOUND_CURSOR_KEY, String(highest)); }
  return summary;
}

// ==========================================================================
// 90_Entrypoints.gs
// ==========================================================================

/**
 * Entry points — the functions a trigger calls. NO LOGIC LIVES HERE.
 *
 * Everything here just wires tested pieces together. If you find yourself
 * writing an `if` in this file, it belongs in 60_Intake.gs where it can be
 * tested.
 *
 * SHADOW FIRST. `runShadow()` reads Gmail, classifies, logs every decision and
 * writes nothing — no monday item, no ledger row — on its own cursor. Run it for
 * a few days and diff its verdicts against Make's ledger before `runLive()` is
 * ever installed. After the day this project has had, finding divergence in a
 * log is much cheaper than finding it in the boards.
 */

function props_() { return PropertiesService.getScriptProperties(); }

function newRunId_() {
  return 'r' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function stateStore_() {
  var p = PropertiesService.getUserProperties();
  return {
    getCursor: function (k) { return p.getProperty(k) || ''; },
    setCursor: function (k, v) { p.setProperty(k, String(v)); }
  };
}

function buildDeps_(opts) {
  opts = opts || {};
  var adapter = createSheetAdapter(LEDGER_SPREADSHEET_ID);
  var gmail = createGmailService();
  var mailbox = gmail.getProfileEmail();
  var log = createRunLog(adapter, {
    runId: opts.runId || newRunId_(),
    mailbox: mailbox,
    startedMs: Date.now()
  });
  return {
    gmail: gmail,
    monday: mondayReader_(),
    ledger: createLedger(adapter),
    state: stateStore_(),
    log: log,
    now: function () { return new Date().toISOString(); }
  };
}

/**
 * Board name map. In shadow mode this is the ONLY monday call made, and it is
 * read-only. The per-user scripts get it via the Web App so they hold no token.
 */
function mondayReader_() {
  return {
    boardNameMap: function () {
      var token = props_().getProperty(PROP_MONDAY_TOKEN);
      if (token) { return createMondayClient(token).boardNameMap(); }
      return callWebApp_('boardNameMap', {});
    },
    recentUpdates: function (limit) {
      var token = props_().getProperty(PROP_MONDAY_TOKEN);
      if (token) { return createMondayClient(token).recentUpdates(limit); }
      return callWebApp_('recentUpdates', { limit: limit });
    }
  };
}

/** Script Properties, wrapped so the outbound tests can hand in a fake. */
function propStore_() {
  var p = props_();
  return {
    get: function (k) { return p.getProperty(k); },
    set: function (k, v) { p.setProperty(k, String(v)); }
  };
}

function callWebApp_(action, payload) {
  var url = props_().getProperty(PROP_WEBAPP_URL);
  var secret = props_().getProperty(PROP_WEBAPP_SECRET);
  if (!url) { throw new Error('G247_WEBAPP_URL is not set in Script Properties'); }
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ secret: secret, action: action, payload: payload || {} }),
    muteHttpExceptions: true
  });
  var body = res.getContentText();
  var parsed;
  try { parsed = JSON.parse(body); } catch (e) {
    throw new Error('web app returned non-JSON (HTTP ' + res.getResponseCode() + '): ' + body.slice(0, 300));
  }
  if (!parsed.ok) { throw new Error('web app error: ' + (parsed.error || 'unknown')); }
  return parsed.result;
}

// ------------------------------------------------------------------ RUNNERS
/** Observe only. Writes nothing anywhere except the run log. */
function runShadow() {
  var deps = buildDeps_();
  var summary = runIntake(deps, { shadow: true });
  console.log(deps.log.summary(Object.assign({ endedMs: Date.now() }, summary)));
  return summary;
}

/** The real thing. Do not install until the shadow diff is clean. */
function runLive() {
  var deps = buildDeps_();
  deps.writer = createWriter_(deps);
  var summary = runIntake(deps, {});

  // Outbound runs in the SAME pass, after intake, and must never be able to
  // break it: the inbound half is the system of record, the mirror is a
  // convenience. It is also a no-op unless G247_BRIDGE_MODE is self or thread.
  try {
    summary.outbound = runOutboundPass(outboundDeps_(deps), {});
  } catch (e) {
    deps.log.error('outbound', { detail: 'outbound pass failed, intake unaffected: ' + (e && e.message) });
  }

  console.log(deps.log.summary(Object.assign({ endedMs: Date.now() }, summary)));
  return summary;
}

/** Everything the outbound bridge needs, all injectable for tests. */
function outboundDeps_(deps) {
  return {
    monday: deps.monday,
    gmail: deps.gmail,
    ledger: deps.ledger,
    state: deps.state,
    props: propStore_(),
    log: deps.log,
    now: deps.now,
    nowMs: function () { return Date.now(); },
    b64: function (str) { return Utilities.base64Encode(str, Utilities.Charset.UTF_8); }
  };
}

/**
 * Run the outbound bridge on its own, by hand. Use this while proving it —
 * it does exactly what the scheduled pass does, without the intake.
 */
function runOutboundOnce() {
  var deps = buildDeps_();
  var summary = runOutboundPass(outboundDeps_(deps), {});
  console.log(JSON.stringify(summary, null, 2));
  deps.log.flush();
  return summary;
}

/**
 * Same, but sends NOTHING — logs what it would have sent and to whom.
 * Run this first. Always.
 */
function runOutboundDryRun() {
  var deps = buildDeps_();
  var summary = runOutboundPass(outboundDeps_(deps), { dryRun: true });
  console.log(JSON.stringify(summary, null, 2));
  deps.log.flush();
  return summary;
}

/**
 * ONE-OFF REPAIR: restore the true case of stored Message-IDs.
 *
 * Every ledger row written before 23 Aug holds a lowercased Message-ID, because
 * the dedup key's normaliser was used for the stored header value too. The
 * outbound relay puts that value into In-Reply-To/References, and a lowercased
 * id does not match the real one, so relayed mail starts a new conversation
 * instead of joining the project thread.
 *
 * This re-reads each thread from Gmail and rewrites the header value with the
 * case Gmail actually has. It touches ONLY the headerMessageId column on
 * `thread` and `item` rows — never the `key` column, which the dedup index is
 * built from and which must stay lowercased or every processed email would look
 * new again.
 *
 * Run it once, as the mailbox owner. Safe to re-run: rows already correct are
 * left alone. Run repairLedgerMessageIdsPreview() first to see what it would do.
 */
function repairLedgerMessageIds() { return repairLedgerMessageIds_(false); }
function repairLedgerMessageIdsPreview() { return repairLedgerMessageIds_(true); }

function repairLedgerMessageIds_(dryRun) {
  var sh = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getSheetByName(LEDGER_SHEET);
  if (!sh) { throw new Error('ledger sheet not found'); }
  var values = sh.getDataRange().getValues();
  var col = {};
  values[0].forEach(function (h, i) { col[String(h)] = i; });

  var out = { dryRun: !!dryRun, checked: 0, fixed: 0, alreadyCorrect: 0,
              noThread: 0, notMine: 0, failed: 0, changes: [] };
  var cache = {};

  for (var r = 1; r < values.length; r++) {
    var kind = String(values[r][col.kind]);
    if (kind !== 'thread' && kind !== 'item') { continue; }
    var threadId = String(values[r][col.threadId] || '');
    var stored = String(values[r][col.headerMessageId] || '');
    if (!threadId || !stored) { out.noThread++; continue; }
    out.checked++;

    if (!(threadId in cache)) {
      try {
        var t = Gmail.Users.Threads.get('me', threadId, {
          format: 'metadata', metadataHeaders: ['Message-ID']
        });
        var first = (t && t.messages && t.messages[0]) || null;
        var hs = (first && first.payload && first.payload.headers) || [];
        var found = '';
        hs.forEach(function (h) {
          if (String(h.name).toLowerCase() === 'message-id') { found = h.value || ''; }
        });
        cache[threadId] = bareMessageId(found);
      } catch (e) {
        // A thread that belongs to a different mailbox cannot be read from here.
        // That is expected once other PMs are live; it is not a failure.
        cache[threadId] = null;
      }
    }

    var real = cache[threadId];
    if (real === null) { out.notMine++; continue; }
    if (!real) { out.failed++; continue; }
    if (real === stored) { out.alreadyCorrect++; continue; }

    out.fixed++;
    if (out.changes.length < 20) {
      out.changes.push(kind + ' row ' + (r + 1) + ': ' + stored + '  ->  ' + real);
    }
    if (!dryRun) { sh.getRange(r + 1, col.headerMessageId + 1).setValue(real); }
  }

  console.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * BACKFILL THE PARTICIPANTS COLUMN.
 *
 * The live writer records participants on create and rewrites them on every
 * append, so the column fills FORWARD ONLY. Every thread already in the ledger
 * when the column shipped has nothing in it — and the CLIENT relay takes its
 * entire recipient list from that column. Without this, the relay would run on
 * those threads, log a clean pass, and address nobody: a silent discard that
 * reads as success, which is this project's signature failure.
 *
 * Semantics deliberately MIRROR THE LIVE WRITER rather than improve on it.
 * The live writer stores the LAST message's From/To/Cc, so this stores the last
 * message's too. Taking the union of every message in the thread was the
 * tempting alternative and is wrong: someone dropped from a conversation would
 * be silently re-added to it, and the backfilled rows would not match the rows
 * written either side of them.
 *
 * Threads that already have a participants row are skipped — a live row is
 * fresher than anything reconstructed here, and must never be clobbered by a
 * repair.
 *
 * Runs as the PM, in the PM's mailbox: each PM runs it once for their own
 * threads. A thread belonging to somebody else cannot be read from here and is
 * counted as notMine, not as a failure.
 */
function backfillParticipants() { return backfillParticipants_(false); }
function backfillParticipantsPreview() { return backfillParticipants_(true); }

var BACKFILL_MAX_THREADS = 200;

function backfillParticipants_(dryRun) {
  var sh = SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getSheetByName(LEDGER_SHEET);
  if (!sh) { throw new Error('ledger sheet not found'); }
  var values = sh.getDataRange().getValues();
  var col = {};
  values[0].forEach(function (h, i) { col[String(h)] = i; });

  if (col.participants === undefined) {
    throw new Error('the ledger has no "participants" column. Paste the current ' +
      'Code.gs and run verifyInstall first — runLive creates the column on its ' +
      'next pass, and this repair must not create it by hand.');
  }

  var out = { dryRun: !!dryRun, threads: 0, alreadyHave: 0, wrote: 0,
              notMine: 0, empty: 0, remaining: 0, samples: [] };

  // Distinct threads that need one, in ledger order, newest row wins nothing —
  // presence is all that matters here.
  var need = [];
  var seen = {};
  var have = {};
  for (var r = 1; r < values.length; r++) {
    var kind = String(values[r][col.kind] || '');
    var threadId = String(values[r][col.threadId] || '');
    if (!threadId) { continue; }
    if (kind === 'participants') { have[threadId] = true; continue; }
    if (kind !== 'thread' && kind !== 'item') { continue; }
    if (seen[threadId]) { continue; }
    seen[threadId] = true;
    need.push({ threadId: threadId, mondayItemId: String(values[r][col.mondayItemId] || ''),
                mailbox: String(values[r][col.mailbox] || ''),
                boardId: String(values[r][col.boardId] || ''),
                subject: String(values[r][col.subject] || '') });
  }

  var pending = need.filter(function (n) {
    if (have[n.threadId]) { out.alreadyHave++; return false; }
    return true;
  });

  if (pending.length > BACKFILL_MAX_THREADS) {
    out.remaining = pending.length - BACKFILL_MAX_THREADS;
    pending = pending.slice(0, BACKFILL_MAX_THREADS);
  }

  var ledger = createLedger(createSheetAdapter(LEDGER_SPREADSHEET_ID));

  pending.forEach(function (n) {
    out.threads++;
    var last = null;
    try {
      var t = Gmail.Users.Threads.get('me', n.threadId, {
        format: 'metadata', metadataHeaders: ['From', 'To', 'Cc']
      });
      var msgs = (t && t.messages) || [];
      last = msgs.length ? msgs[msgs.length - 1] : null;
    } catch (e) {
      out.notMine++;
      return;
    }
    if (!last) { out.notMine++; return; }

    var h = {};
    ((last.payload && last.payload.headers) || []).forEach(function (x) {
      h[String(x.name).toLowerCase()] = x.value || '';
    });

    var list = collectParticipants(h.from, h.to, h.cc);
    if (!list.length) { out.empty++; return; }

    out.wrote++;
    if (out.samples.length < 10) {
      out.samples.push(n.threadId + ' -> ' + list.join(', '));
    }
    if (!dryRun) {
      ledger.stageParticipants({
        threadId: n.threadId, mondayItemId: n.mondayItemId, mailbox: n.mailbox,
        boardId: n.boardId, subject: n.subject, gmailMessageId: last.id || '',
        createdAt: new Date().toISOString(), participants: list
      });
    }
  });

  if (!dryRun) { ledger.flush(); }

  console.log(JSON.stringify(out, null, 2));
  return out;
}

/** off | self | thread. Unset means off — turning it on must be deliberate. */
function setBridgeModeOff() { return setBridgeMode_('off'); }
function setBridgeModeSelf() { return setBridgeMode_('self'); }
function setBridgeModeThread() { return setBridgeMode_('thread'); }

function setBridgeMode_(mode) {
  props_().setProperty(PROP_BRIDGE_MODE, mode);
  console.log('bridge mode is now: ' + mode);
  return mode;
}

/** Where the outbound bridge stands right now. Reads nothing external. */
function outboundStatus() {
  var p = props_();
  var out = {
    mode: p.getProperty(PROP_BRIDGE_MODE) || DEFAULT_BRIDGE_MODE + ' (unset)',
    marker: OUTBOUND_MARKER,
    cursor: PropertiesService.getUserProperties().getProperty(OUTBOUND_CURSOR_KEY) || '(unseeded)',
    rateWindow: p.getProperty(PROP_BRIDGE_RATE) || '(no sends this window)',
    capPerHour: OUTBOUND_MAX_PER_HOUR
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Prefer a LOCAL monday client when this script holds the token.
 *
 * That is what lets one mailbox go live with no Web App deployed at all — fewer
 * moving parts on the day it first writes to your boards. It also keeps
 * attachments working, because only the script running as the mailbox owner can
 * read that mailbox's attachment bytes.
 *
 * The Web App path exists for the other four people, who must not hold a monday
 * admin token. They lose server-side attachment upload; that is the price of not
 * distributing the token, and it is logged rather than hidden.
 */
function createWriter_(deps) {
  var token = props_().getProperty(PROP_MONDAY_TOKEN);
  if (token) {
    return createWriter(createMondayClient(token), deps.gmail, deps.log);
  }
  return {
    createProject: function (a) { return callWebApp_('createProject', a); },
    appendUpdate: function (a) { return callWebApp_('appendUpdate', a); },
    deadLetter: function (a) { return callWebApp_('deadLetter', a); }
  };
}

// ----------------------------------------------------------------- TRIGGERS
function installShadowTrigger() {
  removeTriggersFor_('runShadow');
  ScriptApp.newTrigger('runShadow').timeBased().everyMinutes(5).create();
  return 'runShadow installed at 5-minute intervals';
}

/**
 * 1-minute polling costs roughly 21% of the 6-hour per-user trigger budget —
 * an idle run is one history.list call and finishes in a couple of seconds.
 * Comfortable, and 60x better than the hourly polling Make could afford at five
 * mailboxes.
 */
function installLiveTrigger() {
  removeTriggersFor_('runLive');
  ScriptApp.newTrigger('runLive').timeBased().everyMinutes(1).create();
  return 'runLive installed at 1-minute intervals';
}

function removeTriggersFor_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) { ScriptApp.deleteTrigger(t); }
  });
}

function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  return 'all triggers removed';
}

// --------------------------------------------------------- SETUP / DIAGNOSTIC
/** Run once by hand. Confirms scopes, mailbox, sheet access and board matching. */
function preflight() {
  var out = { ok: true, checks: [] };
  function ck(name, fn) {
    try { out.checks.push({ name: name, result: String(fn()) }); }
    catch (e) { out.ok = false; out.checks.push({ name: name, error: String(e && e.message) }); }
  }
  ck('gmail profile', function () { return createGmailService().getProfileEmail(); });
  ck('mailbox on allow-list', function () {
    var m = createGmailService().getProfileEmail().toLowerCase();
    if (!MAILBOX_TO_MONDAY_USER[m]) { throw new Error(m + ' is NOT in MAILBOX_TO_MONDAY_USER'); }
    return 'yes -> monday user ' + MAILBOX_TO_MONDAY_USER[m];
  });
  ck('spreadsheet', function () {
    return SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID).getName();
  });
  ck('user labels', function () {
    var n = Object.keys(createGmailService().labelsList().userLabelMap).length;
    return n + ' user labels';
  });
  ck('board name map', function () {
    var map = mondayReader_().boardNameMap();
    return Object.keys(map).length + ' boards';
  });
  ck('labels matching a board', function () {
    var labels = createGmailService().labelsList().userLabelMap;
    var map = mondayReader_().boardNameMap();
    var hits = [];
    // Must use the SAME key rules as the classifier, including the nested-label
    // leaf. Checking only the full path here would report NONE for a label filed
    // under a folder that the live run would happily match — a false alarm
    // during rollout is worse than no check at all.
    Object.keys(labels).forEach(function (id) {
      var keys = labelMatchKeys(labels[id]);
      for (var i = 0; i < keys.length; i++) {
        if (map[keys[i]]) { hits.push(labels[id] + ' -> ' + map[keys[i]].name); return; }
      }
    });
    return hits.length ? hits.join(' | ') : 'NONE — no label matches a board name exactly';
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}

/* The Make ledger migration lives in 55_Migration.gs — importMakeLedger() and
   previewMakeLedgerImport(). It carries the data snapshot with it. */

// ==========================================================================
// 95_WebApp.gs
// ==========================================================================

/**
 * Central Web App — the single holder of the monday API token.
 *
 * NOT NEEDED to run one mailbox. A script whose own Script Properties carry
 * G247_MONDAY_TOKEN writes to monday directly (see createWriter_ in
 * 90_Entrypoints.gs). Deploy this only when rolling out to the other four
 * people, so that four more copies of an admin token do not exist.
 *
 * SECURITY, PLAINLY
 * -----------------
 * A Web App that Pub/Sub or another script can reach must be deployed "Anyone",
 * which means an unauthenticated public URL. It WILL be found by scanners. The
 * shared secret below is what stands between that URL and your monday account,
 * so:
 *   - generate a long random secret (32+ chars) and set G247_WEBAPP_SECRET
 *   - never log the secret, never put it in a comment, never commit it
 *   - the URL alone must never be sufficient to do anything
 *
 * The comparison is length-then-content on purpose; a mismatch returns the same
 * shaped error whatever went wrong, so the endpoint gives nothing away.
 */

function doPost(e) {
  var out = { ok: false };
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var expected = PropertiesService.getScriptProperties().getProperty(PROP_WEBAPP_SECRET);

    if (!expected) { throw new Error('server not configured'); }
    if (!secretMatches_(body.secret, expected)) { throw new Error('unauthorised'); }

    out.result = dispatchWebAppAction_(body.action, body.payload || {});
    out.ok = true;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Constant-ish time compare. Not perfect in JS, but not trivially timeable. */
function secretMatches_(given, expected) {
  var a = String(given || '');
  var b = String(expected || '');
  if (a.length !== b.length) { return false; }
  var diff = 0;
  for (var i = 0; i < a.length; i++) { diff |= (a.charCodeAt(i) ^ b.charCodeAt(i)); }
  return diff === 0;
}

function dispatchWebAppAction_(action, payload) {
  var token = PropertiesService.getScriptProperties().getProperty(PROP_MONDAY_TOKEN);
  if (!token) { throw new Error('G247_MONDAY_TOKEN is not set on the web app'); }
  var monday = createMondayClient(token);

  switch (action) {
    case 'ping':
      return { ok: true };

    case 'boardNameMap':
      return monday.boardNameMap();

    case 'createProject':
      // NOTE: attachments cannot be handled here for someone else's mailbox —
      // this deployment runs as one user and cannot read another person's Gmail.
      // The caller uploads its own attachments, or they are skipped and logged.
      return createWriter(monday, nullGmail_(), null).createProject(payload);

    case 'appendUpdate':
      return createWriter(monday, nullGmail_(), null).appendUpdate(payload);

    case 'deadLetter':
      return createWriter(monday, nullGmail_(), null).deadLetter(payload);

    default:
      throw new Error('unknown action: ' + action);
  }
}

/**
 * Stands in for Gmail on the server side, where another user's mailbox is
 * unreachable. Every attachment then reports as skipped with a clear reason
 * rather than appearing to have uploaded.
 */
function nullGmail_() {
  return {
    attachmentBlob: function () {
      throw new Error('attachments are not available server-side for another mailbox');
    }
  };
}

/** Run after deploying, to confirm the URL and secret line up. */
function testWebApp() {
  var res = callWebApp_('ping', {});
  console.log('[G247] web app ping: ' + JSON.stringify(res));
  return res;
}

// ==========================================================================
// 99_Verify.gs
// ==========================================================================

/**
 * Install verifier — run this after any paste, before running anything else.
 *
 * Apps Script puts every file in ONE shared global scope, so pasting a file's
 * contents into the wrong filename does not error: it silently redefines
 * whatever loaded first and the missing function simply is not there.

 * The project now installs as ONE generated file (dist/Code.gs, built by
 * tools/build.js), which removes the wrong-tab failure entirely. This check
 * stays because a truncated or half-finished paste still looks like success:
 * the file saves, and only the missing tail is gone. The file names below now
 * name the SOURCE MODULE a symbol came from, not an editor tab. That
 * happened once already on this project (80_MondayClient's contents ended up in
 * 90_Entrypoints), and the only symptom was a function missing from a dropdown.
 *
 * This checks every symbol the system needs and names the file each missing one
 * should have come from, so a bad paste takes seconds to find instead of
 * surfacing later as a strange runtime failure.
 */

var EXPECTED_SYMBOLS = [
  ['00_Config.gs', ['MAILBOX_TO_MONDAY_USER', 'COLUMNS', 'LEDGER_SPREADSHEET_ID',
    'AUTOMATION_SENDERS', 'DEADLETTER_COLUMNS', 'INTEGRATION_USER_IDS',
    'normalizeBase64Url', 'padBase64', 'toStandardBase64', 'looksLikeBase64',
     'isProjectBoard', 'labelMatchKeys']],
  ['10_Extractor.gs', ['extractCandidates', 'isUserLabel']],
  ['20_Classifier.gs', ['classifyMessage']],
  ['30_ColumnValues.gs', ['buildColumnValues']],
  ['35_UpdateBody.gs', ['toMondayDateTime', 'formatUpdateBody', 'escapeHtml']],
  ['40_Store.gs', ['createLedger', 'normalizeMessageId', 'bareMessageId',
    'collectParticipants', 'LEDGER_HEADERS', 'backfillParticipants']],
  ['45_RunLog.gs', ['createRunLog', 'RUNLOG_HEADERS']],
  ['50_SheetAdapter.gs', ['createSheetAdapter']],
  ['55_Migration.gs', ['importMakeLedger', 'previewMakeLedgerImport',
    'MAKE_THREAD_ROWS', 'MAKE_ITEM_ROWS', 'MAKE_MSG_ROWS']],
  ['60_Intake.gs', ['runIntake', 'applyDecision']],
  ['70_GmailService.gs', ['createGmailService']],
  ['80_MondayClient.gs', ['createMondayClient']],
  ['85_Writer.gs', ['createWriter', 'isPersonAssignmentError', 'MAX_ATTACHMENT_BYTES']],
  ['88_Outbound.gs', ['runOutboundPass', 'shouldMirrorUpdate', 'parseOutboundMarker',
    'outboundRecipients', 'buildMirrorMime', 'replySubject', 'encodeSubject',
    'mirrorHtml', 'outboundRateGate', 'OUTBOUND_MARKER', 'OUTBOUND_MAX_PER_HOUR']],
  ['90_Entrypoints.gs', ['preflight', 'runShadow', 'runLive',
    'runOutboundOnce', 'runOutboundDryRun', 'outboundStatus', 'setBridgeMode_',
    'repairLedgerMessageIds', 'repairLedgerMessageIdsPreview',
    'installShadowTrigger', 'installLiveTrigger', 'removeAllTriggers']],
  ['95_WebApp.gs', ['doPost', 'testWebApp']]
];

function verifyInstall() {
  var missing = [];
  var ok = 0;

  EXPECTED_SYMBOLS.forEach(function (entry) {
    var file = entry[0];
    entry[1].forEach(function (name) {
      var present;
      try { present = (eval('typeof ' + name) !== 'undefined'); }
      catch (e) { present = false; }
      if (present) { ok++; } else { missing.push(name + '  <- expected from ' + file); }
    });
  });

  var out = { ok: missing.length === 0, symbolsFound: ok, missing: missing };

  if (out.ok) {
    console.log('[G247] install OK — all ' + ok + ' expected symbols present.');
  } else {
    console.log('[G247] INSTALL INCOMPLETE — ' + missing.length + ' symbol(s) missing:');
    missing.forEach(function (m) { console.log('  ' + m); });
    console.log('Check that each file contains its OWN contents. Apps Script shares one');
    console.log('global scope, so a file pasted under the wrong name overwrites silently.');
  }

  // Cheap sanity checks that a file is not merely present but plausible.
  if (out.ok) {
    var notes = [];
    if (Object.keys(MAILBOX_TO_MONDAY_USER).length !== 5) {
      notes.push('MAILBOX_TO_MONDAY_USER has ' + Object.keys(MAILBOX_TO_MONDAY_USER).length + ' entries, expected 5');
    }
    if (MAKE_MSG_ROWS.length !== 29 || MAKE_THREAD_ROWS.length !== 13 || MAKE_ITEM_ROWS.length !== 5) {
      notes.push('Make snapshot looks wrong: ' + MAKE_MSG_ROWS.length + ' msg / ' +
        MAKE_THREAD_ROWS.length + ' thread / ' + MAKE_ITEM_ROWS.length + ' item (expected 29/13/5)');
    }
    if (LEDGER_HEADERS.indexOf('participants') === -1) {
      notes.push('LEDGER_HEADERS has no "participants" column — this is an older ' +
        'paste, and the outbound relay would have no way to learn who is on a thread');
    }
    if (INTEGRATION_USER_IDS.indexOf(37824531) === -1) {
      notes.push('37824531 (David Noble, the legacy Make identity) is missing from ' +
        'INTEGRATION_USER_IDS — the bridge would echo its own writes during the parallel run');
    }
    if (notes.length) {
      out.ok = false;
      out.notes = notes;
      console.log('[G247] WARNINGS:');
      notes.forEach(function (n) { console.log('  ' + n); });
    }
  }

  return out;
}

