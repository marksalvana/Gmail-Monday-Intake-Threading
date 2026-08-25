'use strict';
/**
 * Participant list — what the outbound relay will address a client email to.
 *
 * The relay runs as projects@ and cannot read the PM's thread, so this list is
 * the only record of who is on a conversation. If it is wrong, a client email
 * goes to the wrong people or to nobody.
 *
 *   node test/run_participants.js
 */
const { loadSandbox, suite, check, eq, truthy, report } = require('./harness');
const S = loadSandbox();

suite('collectParticipants');

check('collects From, To and Cc in that order, deduped and lowercased', () => {
  eq(S.collectParticipants(
    'Leo Cookson <Leo@PageProof.com>',
    'Mark Salvana <msalvana@group247ww.com>, sgow@group247ww.com',
    'Leo@pageproof.com, j.lee@inovapharma.com'
  ), ['leo@pageproof.com', 'msalvana@group247ww.com',
      'sgow@group247ww.com', 'j.lee@inovapharma.com']);
});

check("monday's own item address is never a participant", () => {
  eq(S.collectParticipants(
    'client@inovapharma.com',
    'pulse-12872088766@g247ww.us.monday.com, msalvana@group247ww.com',
    ''
  ), ['client@inovapharma.com', 'msalvana@group247ww.com'],
    'leaving it in would mail monday a copy of its own email');
});

check('empty and missing headers yield an empty list, not a crash', () => {
  eq(S.collectParticipants('', '', ''), []);
  eq(S.collectParticipants(null, undefined, ''), []);
  eq(S.collectParticipants('no addresses here', '', ''), []);
});

suite('Ledger — participant rows');

function fakeAdapter() {
  const rows = [];
  return {
    _rows: rows,
    ensureSheet: () => {},
    readAll: () => rows.slice(),
    append: (name, newRows) => {
      newRows.forEach((r) => {
        const o = {};
        S.LEDGER_HEADERS.forEach((h, i) => { o[h] = r[i]; });
        rows.push(o);
      });
    },
    trimTo: () => {}
  };
}

check('a participant row round-trips through the sheet shape', () => {
  const a = fakeAdapter();
  const led = S.createLedger(a);
  led.stageParticipants({
    threadId: 'THREAD1', mondayItemId: '999', mailbox: 'msalvana@group247ww.com',
    createdAt: '2026-08-23T00:00:00.000Z',
    participants: ['leo@pageproof.com', 'msalvana@group247ww.com']
  });
  eq(led.flush(), 1);

  const fresh = S.createLedger(a);
  eq(fresh.threadParticipants('THREAD1'),
     ['leo@pageproof.com', 'msalvana@group247ww.com'],
     'the relay reads this back from the sheet, not from memory');
});

check('THE NEWEST LIST WINS — a reply refreshes the thread', () => {
  const a = fakeAdapter();
  const led = S.createLedger(a);
  led.stageParticipants({ threadId: 'T', participants: ['a@x.com'] });
  led.flush();
  led.stageParticipants({ threadId: 'T', participants: ['a@x.com', 'b@y.com'] });
  led.flush();

  eq(S.createLedger(a).threadParticipants('T'), ['a@x.com', 'b@y.com'],
    'rows are appended, never updated; the last one read is the current one');
});

check('an unknown thread returns an empty list rather than undefined', () => {
  eq(S.createLedger(fakeAdapter()).threadParticipants('NOPE'), []);
  eq(S.createLedger(fakeAdapter()).threadParticipants(''), []);
});

check('participant rows do not disturb the other indexes', () => {
  const a = fakeAdapter();
  const led = S.createLedger(a);
  led.stageThreadAnchor({ threadId: 'T', mondayItemId: '55', headerMessageId: 'r@x' });
  led.stageParticipants({ threadId: 'T', participants: ['a@x.com'] });
  led.flush();

  const fresh = S.createLedger(a);
  eq(fresh.threadAnchor('T'), '55', 'the anchor still resolves');
  eq(fresh.threadParticipants('T'), ['a@x.com']);
});

check('the new column is at the END of the header row', () => {
  eq(S.LEDGER_HEADERS[S.LEDGER_HEADERS.length - 1], 'participants',
    'appending keeps every existing column at the index older rows were written at');
});

/* ------------------------------------------------------------------
 * The header patch. Rows are written POSITIONALLY from LEDGER_HEADERS but
 * read back by the sheet's own header row, so a sheet that predates a column
 * would write the new value into an unlabelled column and never read it back.
 * That is this project's recurring bug — a silent discard that reads as
 * success — so the patch is tested rather than trusted.
 * ---------------------------------------------------------------- */

function fakeSpreadsheet(sheets) {
  function makeSheet(name, header) {
    var grid = header ? [header.slice()] : [];
    return {
      name: name,
      grid: grid,
      frozen: 0,
      getLastColumn: function () { return grid.length ? grid[0].length : 0; },
      getLastRow: function () { return grid.length; },
      getDataRange: function () {
        var self = this;
        var w = grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
        return self.getRange(1, 1, Math.max(grid.length, 1), Math.max(w, 1));
      },
      appendRow: function (row) { grid.push(row.slice()); },
      setFrozenRows: function (n) { this.frozen = n; },
      getRange: function (row, col, nRows, nCols) {
        return {
          getValues: function () {
            var out = [];
            for (var r = 0; r < nRows; r++) {
              var line = [];
              for (var c = 0; c < nCols; c++) {
                var src = grid[row - 1 + r];
                line.push(src ? (src[col - 1 + c] === undefined ? '' : src[col - 1 + c]) : '');
              }
              out.push(line);
            }
            return out;
          },
          setValues: function (vals) {
            for (var r = 0; r < vals.length; r++) {
              var target = row - 1 + r;
              if (!grid[target]) { grid[target] = []; }
              for (var c = 0; c < vals[r].length; c++) {
                grid[target][col - 1 + c] = vals[r][c];
              }
            }
            return this;
          },
          setFontWeight: function () { return this; }
        };
      }
    };
  }
  var made = {};
  Object.keys(sheets).forEach(function (n) { made[n] = makeSheet(n, sheets[n]); });
  return {
    sheets: made,
    getSheetByName: function (n) { return made[n] || null; },
    insertSheet: function (n) { made[n] = makeSheet(n, null); return made[n]; }
  };
}

function withFakeSpreadsheet(ssObj, fn) {
  S.SpreadsheetApp = { openById: function () { return ssObj; } };
  S.LockService = {
    getScriptLock: function () {
      return { tryLock: function () { return true; }, releaseLock: function () {} };
    }
  };
  try { return fn(); } finally { delete S.SpreadsheetApp; delete S.LockService; }
}

/** Gmail stub: threadId -> last message's headers, or null for "not my mailbox". */
function withFakeGmail(threads, fn) {
  S.Gmail = {
    Users: {
      Threads: {
        get: function (who, threadId) {
          var t = threads[threadId];
          if (!t) { throw new Error('not found'); }
          return { messages: t.map(function (m, i) {
            return { id: 'm' + i, payload: { headers: Object.keys(m).map(function (k) {
              return { name: k, value: m[k] };
            }) } };
          }) };
        }
      }
    }
  };
  try { return fn(); } finally { delete S.Gmail; }
}

suite('Ledger sheet — the header patch');

check('A SHEET THAT PREDATES THE COLUMN GETS IT APPENDED', () => {
  const old = S.LEDGER_HEADERS.slice(0, S.LEDGER_HEADERS.length - 1);
  const ssObj = fakeSpreadsheet({ ledger: old });
  withFakeSpreadsheet(ssObj, () => {
    S.createSheetAdapter('x').ensureSheet('ledger', S.LEDGER_HEADERS);
  });
  eq(ssObj.sheets.ledger.grid[0], S.LEDGER_HEADERS,
    'the header row now matches what the writer emits');
});

check('running twice changes nothing — it is idempotent', () => {
  const ssObj = fakeSpreadsheet({ ledger: S.LEDGER_HEADERS.slice() });
  withFakeSpreadsheet(ssObj, () => {
    const a = S.createSheetAdapter('x');
    a.ensureSheet('ledger', S.LEDGER_HEADERS);
    a.ensureSheet('ledger', S.LEDGER_HEADERS);
  });
  eq(ssObj.sheets.ledger.grid[0], S.LEDGER_HEADERS);
  eq(ssObj.sheets.ledger.grid.length, 1, 'no stray rows');
});

check('an EMPTY header row is filled from column 1, not column 2', () => {
  // The off-by-one that would put every value in the wrong column.
  const ssObj = fakeSpreadsheet({ ledger: [''] });
  withFakeSpreadsheet(ssObj, () => {
    S.createSheetAdapter('x').ensureSheet('ledger', S.LEDGER_HEADERS);
  });
  eq(ssObj.sheets.ledger.grid[0][0], 'kind', 'first header lands in column A');
  eq(ssObj.sheets.ledger.grid[0], S.LEDGER_HEADERS);
});

check('A REORDERED SHEET THROWS RATHER THAN WRITING MISALIGNED ROWS', () => {
  const swapped = S.LEDGER_HEADERS.slice();
  swapped[0] = S.LEDGER_HEADERS[1];
  swapped[1] = S.LEDGER_HEADERS[0];
  const ssObj = fakeSpreadsheet({ ledger: swapped });
  let threw = '';
  withFakeSpreadsheet(ssObj, () => {
    try { S.createSheetAdapter('x').ensureSheet('ledger', S.LEDGER_HEADERS); }
    catch (e) { threw = e.message; }
  });
  truthy(/column 1/.test(threw) && /Refusing/.test(threw),
    'a loud failure beats silently unreadable data — got: ' + threw);
});

check('a missing sheet is still created with the full header row', () => {
  const ssObj = fakeSpreadsheet({});
  withFakeSpreadsheet(ssObj, () => {
    S.createSheetAdapter('x').ensureSheet('ledger', S.LEDGER_HEADERS);
  });
  eq(ssObj.sheets.ledger.grid[0], S.LEDGER_HEADERS);
});

/* ------------------------------------------------------------------
 * The backfill. The column fills forward only, so every thread already in
 * the ledger is empty — and the CLIENT relay's whole recipient list comes
 * from that column. These assertions are about the relay having somebody
 * to address on the projects that already exist.
 * ---------------------------------------------------------------- */

suite('Backfill — filling the column for threads that predate it');

function ledgerSheetWith(rows) {
  const ssObj = fakeSpreadsheet({ ledger: S.LEDGER_HEADERS.slice() });
  rows.forEach((r) => {
    ssObj.sheets.ledger.appendRow(S.LEDGER_HEADERS.map((h) => (r[h] === undefined ? '' : r[h])));
  });
  return ssObj;
}

function runBackfill(ssObj, threads, dry) {
  let res;
  withFakeSpreadsheet(ssObj, () => {
    withFakeGmail(threads, () => {
      S.LEDGER_SPREADSHEET_ID = 'x';
      res = dry ? S.backfillParticipantsPreview() : S.backfillParticipants();
    });
  });
  return res;
}

function participantsRows(ssObj) {
  const grid = ssObj.sheets.ledger.grid;
  const ki = S.LEDGER_HEADERS.indexOf('kind');
  const pi = S.LEDGER_HEADERS.indexOf('participants');
  const ti = S.LEDGER_HEADERS.indexOf('threadId');
  return grid.slice(1).filter((r) => r[ki] === 'participants')
    .map((r) => ({ threadId: r[ti], participants: r[pi] }));
}

check('A THREAD WITH NO PARTICIPANTS ROW GETS ONE', () => {
  const ssObj = ledgerSheetWith([{ kind: 'thread', threadId: 'T1', mondayItemId: '9' }]);
  const res = runBackfill(ssObj, {
    T1: [{ From: 'client@inova.com', To: 'pm@group247ww.com' }]
  }, false);
  eq(res.wrote, 1);
  eq(participantsRows(ssObj), [{ threadId: 'T1', participants: 'client@inova.com, pm@group247ww.com' }]);
});

check('IT MIRRORS THE LIVE WRITER — the LAST message, not the union', () => {
  // Someone dropped from a conversation must stay dropped. A union would
  // silently re-add them, and the backfilled row would not match the rows
  // written either side of it.
  const ssObj = ledgerSheetWith([{ kind: 'thread', threadId: 'T1', mondayItemId: '9' }]);
  runBackfill(ssObj, {
    T1: [
      { From: 'client@inova.com', To: 'pm@group247ww.com', Cc: 'leaver@inova.com' },
      { From: 'pm@group247ww.com', To: 'client@inova.com' }
    ]
  }, false);
  eq(participantsRows(ssObj), [{ threadId: 'T1', participants: 'pm@group247ww.com, client@inova.com' }]);
});

check('a thread that ALREADY has a row is never clobbered', () => {
  const ssObj = ledgerSheetWith([
    { kind: 'thread', threadId: 'T1', mondayItemId: '9' },
    { kind: 'participants', threadId: 'T1', participants: 'live@inova.com' }
  ]);
  const res = runBackfill(ssObj, { T1: [{ From: 'stale@inova.com' }] }, false);
  eq(res.alreadyHave, 1);
  eq(res.wrote, 0, 'a live row is fresher than anything a repair reconstructs');
  eq(participantsRows(ssObj), [{ threadId: 'T1', participants: 'live@inova.com' }]);
});

check("a thread in SOMEONE ELSE'S mailbox is notMine, not a failure", () => {
  const ssObj = ledgerSheetWith([{ kind: 'thread', threadId: 'T9', mondayItemId: '9' }]);
  const res = runBackfill(ssObj, {}, false);
  eq(res.notMine, 1);
  eq(res.wrote, 0);
  eq(participantsRows(ssObj), [], 'each PM backfills their own threads');
});

check('THE PREVIEW WRITES NOTHING — a dry run that changes state is a lie', () => {
  const ssObj = ledgerSheetWith([{ kind: 'thread', threadId: 'T1', mondayItemId: '9' }]);
  const res = runBackfill(ssObj, { T1: [{ From: 'client@inova.com' }] }, true);
  eq(res.dryRun, true);
  eq(res.wrote, 1, 'it still reports what it would have done');
  eq(participantsRows(ssObj), [], 'and the sheet is untouched');
});

check('one thread, many ledger rows, ONE participants row', () => {
  const ssObj = ledgerSheetWith([
    { kind: 'thread', threadId: 'T1', mondayItemId: '9' },
    { kind: 'item', threadId: 'T1', mondayItemId: '9' },
    { kind: 'message', threadId: 'T1', mondayItemId: '9' }
  ]);
  const res = runBackfill(ssObj, { T1: [{ From: 'a@b.com' }] }, false);
  eq(res.threads, 1, 'threads are deduped before any Gmail call is made');
  eq(participantsRows(ssObj).length, 1);
});

check('monday’s own address is excluded here too', () => {
  const ssObj = ledgerSheetWith([{ kind: 'thread', threadId: 'T1', mondayItemId: '9' }]);
  runBackfill(ssObj, {
    T1: [{ From: 'client@inova.com', To: 'pulse-12872173573@g247ww.us.monday.com' }]
  }, false);
  eq(participantsRows(ssObj), [{ threadId: 'T1', participants: 'client@inova.com' }]);
});

check('a ledger with NO participants column refuses to run', () => {
  const old = S.LEDGER_HEADERS.slice(0, S.LEDGER_HEADERS.length - 1);
  const ssObj = fakeSpreadsheet({ ledger: old });
  ssObj.sheets.ledger.appendRow(old.map(() => ''));
  let threw = '';
  withFakeSpreadsheet(ssObj, () => {
    withFakeGmail({}, () => {
      S.LEDGER_SPREADSHEET_ID = 'x';
      try { S.backfillParticipants(); } catch (e) { threw = e.message; }
    });
  });
  truthy(/verifyInstall/.test(threw),
    'an older paste must be fixed by pasting, not by a repair inventing a column — got: ' + threw);
});

/* ------------------------------------------------------------------
 * The audit. This is the number the go/no-go decision rests on, so the
 * definition of "would reach a client" has to match the relay's exactly —
 * an address the relay filters out is not a client the audit may count.
 * ---------------------------------------------------------------- */

suite('participantsAudit — how many projects would actually reach a client');

check('a real outside human counts', () => {
  eq(S.isReachableClientAddress('n.adroja@inovapharma.com'), true);
  eq(S.isReachableClientAddress('marketing@pageproof.com'), true);
});

check('OUR OWN PEOPLE DO NOT COUNT', () => {
  eq(S.isReachableClientAddress('msalvana@group247ww.com'), false);
  eq(S.isReachableClientAddress('inova_websites@group247ww.com'), false);
});

check('AUTOMATED SENDERS DO NOT COUNT — this is the one that inflates coverage', () => {
  // Both of these were live in the 23 Aug backfill. An audit that counted them
  // would report clients reachable who are not.
  eq(S.isReachableClientAddress('mailer-daemon@googlemail.com'), false);
  eq(S.isReachableClientAddress('notifications@monday.com'), false);
});

check("monday's own item address does not count", () => {
  eq(S.isReachableClientAddress('pulse-12872173573@g247ww.us.monday.com'), false);
  eq(S.isReachableClientAddress(''), false);
});

check('THE AUDIT SPLITS REACHABLE FROM INTERNAL-ONLY', () => {
  const ssObj = ledgerSheetWith([
    { kind: 'item', threadId: 'T1', mondayItemId: '1', subject: 'Has a client' },
    { kind: 'participants', threadId: 'T1', participants: 'msalvana@group247ww.com, n.adroja@inovapharma.com' },
    { kind: 'item', threadId: 'T2', mondayItemId: '2', subject: 'Internal only' },
    { kind: 'participants', threadId: 'T2', participants: 'msalvana@group247ww.com, dnoble@group247ww.com' },
    { kind: 'item', threadId: 'T3', mondayItemId: '3', subject: 'Only a daemon' },
    { kind: 'participants', threadId: 'T3', participants: 'msalvana@group247ww.com, mailer-daemon@googlemail.com' }
  ]);
  let res;
  withFakeSpreadsheet(ssObj, () => {
    S.LEDGER_SPREADSHEET_ID = 'x';
    res = S.participantsAudit();
  });
  eq(res.wouldReachClient, 1);
  eq(res.internalOnly, 2, 'a thread whose only outsider is a daemon has no client on it');
});

check('a thread with no participants row is counted separately, not as a pass', () => {
  const ssObj = ledgerSheetWith([
    { kind: 'item', threadId: 'T1', mondayItemId: '1', subject: 'Never backfilled' }
  ]);
  let res;
  withFakeSpreadsheet(ssObj, () => {
    S.LEDGER_SPREADSHEET_ID = 'x';
    res = S.participantsAudit();
  });
  eq(res.noParticipantsRow, 1);
  eq(res.wouldReachClient, 0);
  truthy(/run backfillParticipants first/.test(res.verdict), res.verdict);
});

report();
