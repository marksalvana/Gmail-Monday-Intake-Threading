'use strict';
/**
 * Seeding a project that was created on the monday board rather than by email.
 *
 * The bypass rung sits ABOVE alreadyProcessed and threadKnown, so every monday
 * automation email for every item passes through it forever. The guard is the
 * feature: seed once, never repoint.
 *
 *   node test/run_seeding.js
 */
const { loadSandbox, suite, check, eq, truthy, report } = require('./harness');
const S = loadSandbox();

const PULSE = 'pulse-12908832032@g247ww.us.monday.com';
const base = (over) => Object.assign({
  fetchOk: true,
  fromHeader: 'projects@group247ww.com',
  to: PULSE + ', msalvana@group247ww.com',
  cc: '',
  subject: 'Project P261344 - Project 12 - pls review & approve/reject - thx',
  syncOrigin: '',
  labelIdsCsv: '',
  labelMap: {}, userLabelMap: {}, boardNameMap: {},
  threadId: 'T-NEW', gmailMessageId: 'G1',
  alreadyProcessed: false, threadKnown: false, bypassItemKnown: false
}, over || {});

suite('pulseItemIdFrom — one regex, two callers');

check('the item id is read out of To or Cc', () => {
  eq(S.pulseItemIdFrom(PULSE, ''), '12908832032');
  eq(S.pulseItemIdFrom('', 'a@b.com, ' + PULSE), '12908832032');
  eq(S.pulseItemIdFrom('someone@group247ww.com', ''), '');
  eq(S.pulseItemIdFrom('', ''), '');
});

check('a lookalike host is not a monday item', () => {
  eq(S.pulseItemIdFrom('pulse-123@notmonday.example.com', ''), '');
});

suite('The seeding decision');

check('AN UNKNOWN ITEM ON AN UNKNOWN THREAD IS SEEDED', () => {
  const d = S.classifyMessage(base());
  eq(d.classification, 'seed-monday-created-item');
  truthy(d.detail.indexOf('itemId=12908832032') > -1, d.detail);
});

check('A KNOWN ITEM IS NEVER RE-SEEDED — the anchor must not move', () => {
  eq(S.classifyMessage(base({ bypassItemKnown: true })).classification,
     'bypass-monday-intake');
});

check('A KNOWN THREAD IS NEVER RE-SEEDED EITHER', () => {
  eq(S.classifyMessage(base({ threadKnown: true })).classification,
     'bypass-monday-intake');
});

check('both known is still just a skip', () => {
  eq(S.classifyMessage(base({ threadKnown: true, bypassItemKnown: true })).classification,
     'bypass-monday-intake');
});

check('the skip says which guard stopped it', () => {
  truthy(S.classifyMessage(base({ threadKnown: true })).detail
    .indexOf('thread already anchored') > -1);
  truthy(S.classifyMessage(base({ bypassItemKnown: true })).detail
    .indexOf('item already indexed') > -1);
});

suite('Seeding never outranks a guard above it');

check('OUR OWN RELAYED COPY IS STILL A LOOP-GUARD SKIP, NOT A SEED', () => {
  eq(S.classifyMessage(base({ syncOrigin: 'relay' })).classification,
     'skipped-monday-outbound',
     'the relay copies every automation email back to the PM carrying the ' +
     'sync header; seeding off one would root the thread on our own echo');
});

check('a genuine automation sender is still excluded', () => {
  eq(S.classifyMessage(base({ fromHeader: 'notifications@monday.com' })).classification,
     'skipped-automation-sender');
});

check('a failed fetch never seeds', () => {
  eq(S.classifyMessage(base({ fetchOk: false })).classification,
     'skipped-fetch-failed');
});

suite('Mail with no item address is untouched');

check('an ordinary labelled client email still creates as before', () => {
  const d = S.classifyMessage(base({
    to: 'msalvana@group247ww.com', fromHeader: 'client@inovapharma.com',
    labelIdsCsv: 'Label_1', labelMap: { Label_1: 'iNova AU NEW' },
    userLabelMap: { Label_1: 'iNova AU NEW' }, boardNameMap: { 'inova au new': { id: '18401123784', name: 'iNova AU NEW' } }
  }));
  eq(d.classification, 'create-matched-board');
});

check('a reply on a known thread still appends', () => {
  eq(S.classifyMessage(base({ to: 'msalvana@group247ww.com',
    fromHeader: 'client@inovapharma.com', threadKnown: true })).classification,
    'append-to-existing-item');
});

report();
