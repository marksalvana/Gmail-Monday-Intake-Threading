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
  try { return fn(); } finally { delete S.SpreadsheetApp; }
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

report();
