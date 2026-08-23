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

report();
