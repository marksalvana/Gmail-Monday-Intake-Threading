
'use strict';
/**
 * The Message-ID case regression, end to end through the intake.
 *
 * The store-level fix alone was a no-op because runIntake flattened the id on
 * arrival — garbage in. This asserts the value that actually reaches the ledger
 * rows the outbound relay reads.
 *
 *   node test/run_intake_msgid.js
 */
const { loadSandbox, suite, check, eq, truthy, report } = require('./harness');
const S = loadSandbox();

const REAL_ID = 'CAAcrcBHWZKGNu0BmsZbxMF0diyYSirCc03y1ydvuS_NXt8Gy+g@mail.gmail.com';

function rig() {
  const staged = { msg: [], thread: [], item: [], participants: [] };
  const ctx = {
    mailbox: 'msalvana@group247ww.com',
    candidate: { mid: 'GID1', tid: 'THREAD1' },
    message: null,
    headerMessageId: S.normalizeMessageId('<' + REAL_ID + '>'),
    rawMessageId: S.bareMessageId('<' + REAL_ID + '>'),
    now: () => '2026-08-23T00:00:00.000Z'
  };
  ctx.message = {
    ok: true, threadId: 'THREAD1', subject: 'New Job 6',
    from: 'Mark <email@marksalvana.com>', senderEmail: 'email@marksalvana.com',
    to: 'msalvana@group247ww.com', cc: 'sgow@group247ww.com',
    bodyHtml: '<p>hi</p>', bodyText: '', bodyError: '', attachments: [],
    internalDate: '1787456277000', headerMessageId: '<' + REAL_ID + '>'
  };
  const deps = {
    ledger: {
      stageMessage: (r) => staged.msg.push(r),
      stageThreadAnchor: (r) => staged.thread.push(r),
      stageItemIndex: (r) => staged.item.push(r),
      stageParticipants: (r) => staged.participants.push(r)
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    writer: {
      createProject: () => ({ itemId: '999', updateId: 'u1', attachments: { uploaded: 0, skipped: [] },
                              columns: { written: [], skipped: [] } }),
      appendUpdate: () => ({ updateId: 'u2', attachments: { uploaded: 0, skipped: [] } }),
      deadLetter: () => ({ itemId: '' })
    }
  };
  return { staged, ctx, deps };
}

suite('Intake — which form of the Message-ID reaches the ledger');

check('THE THREAD AND ITEM ROWS KEEP THE ORIGINAL CASE', () => {
  const r = rig();
  const summary = { created: 0, appended: 0, skipped: 0, errors: 0, deadLettered: 0 };
  S.applyDecision(r.deps, Object.assign({}, r.ctx, {
    decision: { classification: 'create-matched-board', targetBoardId: '18401123784',
                targetGroupId: null, itemName: 'New Job 6' }
  }), summary);

  eq(r.staged.thread.length, 1);
  eq(r.staged.item.length, 1);
  eq(r.staged.thread[0].headerMessageId, REAL_ID,
    'the relay puts this straight into In-Reply-To; lowercasing it breaks threading');
  eq(r.staged.item[0].headerMessageId, REAL_ID);
});

check('the raw form is genuinely different from the dedup form', () => {
  truthy(S.normalizeMessageId(REAL_ID) !== REAL_ID,
    'if these were equal the test would prove nothing');
});

check('a missing rawMessageId falls back rather than writing undefined', () => {
  const r = rig();
  delete r.ctx.rawMessageId;
  const summary = { created: 0, appended: 0, skipped: 0, errors: 0, deadLettered: 0 };
  S.applyDecision(r.deps, Object.assign({}, r.ctx, {
    decision: { classification: 'create-matched-board', targetBoardId: '1',
                targetGroupId: null, itemName: 'x' }
  }), summary);
  eq(r.staged.item[0].headerMessageId, S.normalizeMessageId(REAL_ID));
});

suite('Intake — participants are recorded for the outbound relay');

function run(r, classification, extra) {
  const summary = { created: 0, appended: 0, skipped: 0, errors: 0, deadLettered: 0 };
  S.applyDecision(r.deps, Object.assign({}, r.ctx, {
    decision: Object.assign({ classification: classification, targetBoardId: '1',
                              targetGroupId: null, itemName: 'x',
                              anchorItemId: '999' }, extra || {})
  }), summary);
  return summary;
}

check('creating a project records who is on the thread', () => {
  const r = rig();
  run(r, 'create-matched-board');
  eq(r.staged.participants.length, 1);
  eq(r.staged.participants[0].threadId, 'THREAD1');
  eq(r.staged.participants[0].participants,
     ['email@marksalvana.com', 'msalvana@group247ww.com', 'sgow@group247ww.com']);
});

check('A REPLY REFRESHES THE LIST — this is how it stays current', () => {
  const r = rig();
  r.ctx.message.cc = 'sgow@group247ww.com, newperson@inovapharma.com';
  run(r, 'append-to-existing-item');
  eq(r.staged.participants.length, 1, 'appends record participants too, not just creates');
  truthy(r.staged.participants[0].participants.indexOf('newperson@inovapharma.com') !== -1,
    'somebody added to the conversation must appear without any extra Gmail call');
});

check('a decision NOT to act records no participants', () => {
  const r = rig();
  run(r, 'unmatched-no-board');
  eq(r.staged.participants.length, 0);
});

report();
