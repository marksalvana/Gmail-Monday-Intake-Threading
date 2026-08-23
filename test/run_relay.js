'use strict';
/**
 * Relay tests.
 *
 * The relay can put monday's internal approval chatter into a thread a client
 * can read, so the routing rules get tested harder than the happy path.
 *
 *   node test/run_relay.js
 */
const { loadSandbox, suite, check, eq, truthy, report } = require('./harness');
const S = loadSandbox();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const ANCHOR = {
  mailbox: 'msalvana@group247ww.com',
  threadId: 'THREAD1',
  headerMessageId: 'root@client.example',
  subject: 'Homepage banner refresh'
};

// ================================================================== PARSING
suite('Item id — the exact key that removes all guessing');

check('the monday item id is parsed out of a pulse address', () => {
  eq(S.extractPulseItemIds(['pulse-12345678@g247ww.us.monday.com']), ['12345678']);
});

check('it is found inside a Group Email list alongside real people', () => {
  eq(S.extractPulseItemIds([
    'client@inovapharma.com, pulse-999@g247ww.us.monday.com, sgow@group247ww.com'
  ]), ['999']);
});

check('duplicates collapse, and a non-monday address yields nothing', () => {
  eq(S.extractPulseItemIds(['pulse-7@x.monday.com', 'pulse-7@x.monday.com']), ['7']);
  eq(S.extractPulseItemIds(['someone@group247ww.com']), []);
  eq(S.extractPulseItemIds([]), []);
});

check('a lookalike that is not a monday host is ignored', () => {
  eq(S.extractPulseItemIds(['pulse-123@notmonday.example.com']), []);
});

// ================================================================== ROUTING
suite('Routing — which of the two scripts owns a message');

check('item address only is the internal route', () => {
  eq(S.classifyRoute(['pulse-1@g247ww.us.monday.com']), 'internal');
});

check('THE ITEM PLUS A G247 PERSON IS STILL INTERNAL', () => {
  // Read from the live Sent copy on 22 Aug: monday's config claims this
  // automation sends to p_email alone, and it does not.
  eq(S.classifyRoute([
    'pulse-12872173573@g247ww.us.monday.com', 'msalvana@group247ww.com'
  ]), 'internal', 'nothing has left G247, so it is not client mail');
  eq(S.classifyRoute([
    'pulse-1@g247ww.us.monday.com', 'sgow@group247ww.com', 'mdelarosa@group247ww.com'
  ]), 'internal');
});

check('one outside address makes it client, however many insiders there are', () => {
  eq(S.classifyRoute(['pulse-1@g247ww.us.monday.com', 'j.lee@inovapharma.com']), 'client');
  eq(S.classifyRoute([
    'j.lee@inovapharma.com', 'pulse-1@g247ww.us.monday.com', 'sgow@group247ww.com'
  ]), 'client', 'the Group Email route');
});

check('the domain test matches the whole domain, not a suffix', () => {
  eq(S.isInternalAddress('a@group247ww.com'), true);
  eq(S.isInternalAddress('A@GROUP247WW.COM'), true);
  eq(S.isInternalAddress('a@notgroup247ww.com'), false,
    'a lookalike domain must not be treated as ours');
  eq(S.isInternalAddress('a@group247ww.com.evil.net'), false);
  eq(S.isInternalAddress(''), false);
});

check('no item address at all is neither — it cannot be matched to a project', () => {
  eq(S.classifyRoute(['idemetriou@group247ww.com']), '',
    'the Change Request and due-date automations land here and are out of scope');
  eq(S.classifyRoute([]), '');
});

// ================================================================ DECISIONS
const MSG = (o) => Object.assign({
  ok: true,
  id: 'GM1',
  addresses: ['pulse-555@g247ww.us.monday.com'],
  subject: 'Project Alpha - Approval Feedback rec\'d - APPROVED',
  syncHeader: ''
}, o || {});
const CTX = (o) => Object.assign({
  route: 'internal',
  alreadyRelayed: false,
  anchorFor: () => ANCHOR,
  // A thread with a real client on it. The client route now requires one, so
  // leaving this out would make every client-route assertion pass or fail for
  // the wrong reason.
  participantsFor: () => ['j.lee@inovapharma.com', 'msalvana@group247ww.com']
}, o || {});

suite('shouldRelay — every reason not to send');

check('a matching internal message relays', () => {
  const v = S.shouldRelay(MSG(), CTX());
  eq(v.relay, true);
  eq(v.itemId, '555');
});

check('THE INTERNAL SCRIPT REFUSES CLIENT MAIL, AND VICE VERSA', () => {
  const clientMsg = MSG({ addresses: ['pulse-555@g247ww.us.monday.com', 'j.lee@inovapharma.com'] });
  eq(S.shouldRelay(clientMsg, CTX({ route: 'internal' })).reason, 'other-route:client',
    'this separation is what lets one be switched off without the other');
  eq(S.shouldRelay(MSG(), CTX({ route: 'client' })).reason, 'other-route:internal');
  eq(S.shouldRelay(clientMsg, CTX({ route: 'client' })).relay, true);
});

check('a message already carrying the sync header is never relayed', () => {
  eq(S.shouldRelay(MSG({ syncHeader: 'monday-relay' }), CTX()).reason, 'already-carries-sync-header');
  eq(S.shouldRelay(MSG({ syncHeader: 'monday-bridge' }), CTX()).relay, false,
    'anything the bridge sent is off limits too');
});

check('an item with no ledger row is skipped — most old projects have none', () => {
  const v = S.shouldRelay(MSG(), CTX({ anchorFor: () => null }));
  eq(v.relay, false);
  eq(v.reason, 'item-has-no-gmail-thread');
  eq(v.itemId, '555', 'the id is still reported so the gap is countable');
});

check('a half-populated ledger row is treated as no row, not as usable', () => {
  eq(S.shouldRelay(MSG(), CTX({ anchorFor: () => ({ mailbox: 'a@b.c', threadId: '' }) })).relay, false);
  eq(S.shouldRelay(MSG(), CTX({ anchorFor: () => ({ threadId: 'T', headerMessageId: 'x' }) })).relay, false);
});

check('two item addresses on one message is refused, not guessed', () => {
  const v = S.shouldRelay(MSG({
    addresses: ['pulse-1@g247ww.us.monday.com', 'pulse-2@g247ww.us.monday.com']
  }), CTX());
  eq(v.reason, 'ambiguous-multiple-items');
});

check('an already-relayed message is never sent twice', () => {
  eq(S.shouldRelay(MSG(), CTX({ alreadyRelayed: true })).reason, 'already-relayed');
});

// ===================================================================== MIME
suite('MIME — it must join the thread, not start a new one');

const RELAY_ARGS = {
  to: 'msalvana@group247ww.com',
  threadSubject: 'Homepage banner refresh',
  headerMessageId: 'root@client.example',
  itemId: '555',
  route: 'internal',
  sourceMessageId: 'GM1',
  originalSubject: "Project Alpha - Approval Feedback rec'd - APPROVED",
  sentTo: '',
  html: '<p>monday body</p>'
};

check('THE SUBJECT IS THE THREAD\'S, NOT THE AUTOMATION\'S', () => {
  const raw = S.buildRelayMime(RELAY_ARGS, b64);
  truthy(raw.indexOf('Subject: Re: Homepage banner refresh') !== -1,
    'monday subjects bear no relation to the thread and would split it');
  truthy(raw.indexOf("Subject: Project Alpha") === -1);
});

check('the automation subject survives in the body instead', () => {
  const raw = S.buildRelayMime(RELAY_ARGS, b64);
  truthy(raw.indexOf("Approval Feedback rec&#39;d") !== -1 ||
         raw.indexOf("Approval Feedback rec'd") !== -1, 'nothing is lost by moving it');
});

check('In-Reply-To and References carry the thread root', () => {
  const raw = S.buildRelayMime(RELAY_ARGS, b64);
  truthy(raw.indexOf('In-Reply-To: <root@client.example>') !== -1);
  truthy(raw.indexOf('References: <root@client.example>') !== -1);
});

check('the sync header is stamped so the intake cannot re-ingest it', () => {
  const raw = S.buildRelayMime(RELAY_ARGS, b64);
  truthy(raw.indexOf('X-G247-Sync: monday-relay') !== -1,
    'without this the relayed copy is appended to the item, forever');
  truthy(raw.indexOf('X-G247-Item: 555') !== -1);
});

check('it goes to the PM alone — never to the client', () => {
  const raw = S.buildRelayMime(RELAY_ARGS, b64);
  const to = raw.split('\r\n')[0];
  eq(to, 'To: msalvana@group247ww.com');
  truthy(raw.indexOf('inovapharma') === -1);
});

check('monday HTML is passed through; plain text is escaped', () => {
  truthy(S.relayBody({ itemId: '1', html: '<b>x</b>' }).indexOf('<b>x</b>') !== -1);
  const t = S.relayBody({ itemId: '1', text: '5 < 6 <script>' });
  truthy(t.indexOf('&lt;script&gt;') !== -1);
});

// ============================================================ ORCHESTRATOR
suite('runRelayPass — off, seeding, ordering, failure');

function rig(o) {
  o = o || {};
  const calls = [];
  const cursors = Object.assign({}, o.cursors || {});
  const relayed = new Set(o.relayed || []);
  const attempts = Object.assign({}, o.attempts || {});
  const alerts = [];
  const props = { _s: Object.assign({ [S.PROP_RELAY_MODE]: o.mode || 'on' }, o.props || {}),
                  get(k) { return this._s[k]; }, set(k, v) { this._s[k] = v; } };
  return {
    calls, cursors, alerts,
    deps: {
      gmail: {
        profile: () => 'projects@group247ww.com',
        currentHistoryId: () => 'H999',
        historyList: () => { calls.push('historyList'); return o.page || { messageIds: [], newHistoryId: 'H1000' }; },
        messageMeta: (id) => (o.messages || {})[id] || { ok: false, id },
        sendRaw: () => { calls.push('sendRaw'); if (o.sendThrows) { throw new Error(o.sendThrows); } return 'SENT1'; }
      },
      ledger: {
        itemThread: () => (o.anchor === undefined ? ANCHOR : o.anchor),
        threadParticipants: () => (o.participants === undefined
          ? ['client@inovapharma.com', 'msalvana@group247ww.com'] : o.participants)
      },
      store: {
        hasRelayed: (id) => relayed.has(id),
        attemptsFor: (id) => attempts[id] || (relayed.has(id) ? { last: 'sent', failures: 0 } : null),
        record: (r) => {
          calls.push('record:' + r.result);
          relayed.add(r.sourceMessageId);
          const a = attempts[r.sourceMessageId] || { last: '', failures: 0 };
          a.last = r.result;
          if (r.result === 'FAILED') { a.failures++; }
          attempts[r.sourceMessageId] = a;
        }
      },
      state: { getCursor: (k) => cursors[k] || '',
               setCursor: (k, v) => { cursors[k] = String(v); } },
      props,
      now: () => '2026-08-21T00:00:00.000Z',
      nowMs: () => 1000000,
      b64,
      log: () => {},
      alert: (subject, body) => { alerts.push({ subject, body }); }
    }
  };
}

check('IT REFUSES TO RUN AS THE WRONG MAILBOX', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: MSG() } });
  r.deps.gmail.profile = () => 'msalvana@group247ww.com';
  const s = S.runRelayPass(r.deps, {});
  eq(s.wrongMailbox, 'msalvana@group247ww.com');
  eq(s.relayed, 0);
  eq(r.calls.length, 0, 'sharing the project is not the same as running as the account');
  eq(r.cursors[S.CURSOR_KEY], 'H1', 'and it must not seed a cursor against the wrong mailbox');
});

check('mode off touches nothing at all', () => {
  const r = rig({ mode: 'off', page: { messageIds: ['GM1'], newHistoryId: 'H2' } });
  const s = S.runRelayPass(r.deps, {});
  eq(r.calls.length, 0, 'a disabled relay must cost nothing');
  eq(s.relayed, 0);
});

check('THE FIRST RUN SEEDS AND RELAYS NOTHING', () => {
  const r = rig({ page: { messageIds: ['GM1'], newHistoryId: 'H2' } });
  const s = S.runRelayPass(r.deps, {});
  eq(s.seeded, true);
  eq(s.relayed, 0, 'otherwise switching it on replays history into live threads');
  eq(r.cursors[S.CURSOR_KEY], 'H999');
});

check('A DRY RUN NEVER SEEDS THE CURSOR', () => {
  const r = rig({ page: { messageIds: ['GM1'], newHistoryId: 'H2' }, messages: { GM1: MSG() } });
  const s = S.runRelayPass(r.deps, { dryRun: true });
  eq(s.wouldSeed, true);
  eq(s.seeded, false, 'a preview that changes state is a lie');
  eq(r.cursors[S.CURSOR_KEY], undefined, 'the starting point must be untouched');
});

check('the record is written BEFORE the send, and again after', () => {
  const r = rig({
    cursors: { [S.CURSOR_KEY]: 'H1' },
    page: { messageIds: ['GM1'], newHistoryId: 'H2' },
    messages: { GM1: MSG() }
  });
  S.runRelayPass(r.deps, {});
  eq(r.calls, ['historyList', 'record:sending', 'sendRaw', 'record:sent']);
});

check('a failed relay is recorded as FAILED and not retried', () => {
  const r = rig({
    cursors: { [S.CURSOR_KEY]: 'H1' },
    page: { messageIds: ['GM1'], newHistoryId: 'H2' },
    messages: { GM1: MSG() },
    sendThrows: 'gmail exploded'
  });
  const s = S.runRelayPass(r.deps, {});
  eq(s.failed, 1);
  truthy(r.calls.indexOf('record:FAILED') !== -1);
  eq(r.cursors[S.CURSOR_KEY], 'H2', 'the cursor still advances — no retry loop');
});

check('a dry run sends nothing and records nothing', () => {
  const r = rig({
    cursors: { [S.CURSOR_KEY]: 'H1' },
    page: { messageIds: ['GM1'], newHistoryId: 'H2' },
    messages: { GM1: MSG() }
  });
  const s = S.runRelayPass(r.deps, { dryRun: true });
  eq(r.calls, ['historyList']);
  eq(s.relayed, 1, 'it still reports what it would have done');
});

check('skips are counted by reason so the gaps are visible', () => {
  const r = rig({
    cursors: { [S.CURSOR_KEY]: 'H1' },
    page: { messageIds: ['GM1'], newHistoryId: 'H2' },
    messages: { GM1: MSG() },
    anchor: null
  });
  const s = S.runRelayPass(r.deps, {});
  eq(s.skipped, 1);
  eq(s.reasons['item-has-no-gmail-thread'], 1);
});

// =============================================================== RATE LIMIT
suite('Rate limiter');

function fakeProps(init) {
  const store = Object.assign({}, init || {});
  return { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
}

check('allows up to the cap then refuses, and refusal costs no budget', () => {
  const p = fakeProps();
  for (let i = 0; i < S.RELAY_MAX_PER_HOUR; i++) {
    const g = S.relayRateGate(p, 1000, S.RELAY_MAX_PER_HOUR, 3600000);
    truthy(g.allow);
    g.commit();
  }
  eq(S.relayRateGate(p, 1000, S.RELAY_MAX_PER_HOUR, 3600000).allow, false);
  eq(JSON.parse(p.get(S.PROP_RELAY_RATE)).count, S.RELAY_MAX_PER_HOUR);
});

check('the window rolls over, and corrupt state fails open', () => {
  const p = fakeProps({ [S.PROP_RELAY_RATE]: JSON.stringify({ windowStart: 1000, count: 99 }) });
  eq(S.relayRateGate(p, 1000 + 3600001, 40, 3600000).allow, true);
  eq(S.relayRateGate(fakeProps({ [S.PROP_RELAY_RATE]: 'junk' }), 5000, 40, 3600000).allow, true);
});

// ==================================================== CLIENT ROUTE
suite('Marker routing — telling a client automation from an internal one');

check('THE MARKER OUTRANKS THE DOMAIN RULE', () => {
  // After the change the client is no longer a recipient, so every address
  // left looks internal. Without the marker this would route as internal.
  eq(S.classifyRoute([
    'pulse-123@g247ww.us.monday.com',
    'monday-client-relay@group247ww.com',
    'msalvana@group247ww.com'
  ]), 'client');
});

check('without the marker the same recipients are internal', () => {
  eq(S.classifyRoute([
    'pulse-123@g247ww.us.monday.com', 'msalvana@group247ww.com'
  ]), 'internal');
});

check('the marker alone, with no item address, is still unroutable', () => {
  eq(S.classifyRoute(['monday-client-relay@group247ww.com']), '');
});

check('a real external recipient still routes as client', () => {
  eq(S.classifyRoute([
    'pulse-123@g247ww.us.monday.com', 'client@inovapharma.com'
  ]), 'client');
});

suite('Client recipients — who the relayed copy actually goes to');

check('the client and the PM survive; monday and projects@ do not', () => {
  eq(S.clientRecipients([
    'client@inovapharma.com',
    'projects@group247ww.com',
    'pulse-123@g247ww.us.monday.com',
    'monday-client-relay@group247ww.com',
    'msalvana@group247ww.com'
  ], 'msalvana@group247ww.com'), ['client@inovapharma.com', 'msalvana@group247ww.com']);
});

check('automated senders on the thread are never mailed back', () => {
  eq(S.clientRecipients(
    ['noreply@monday.com', 'do-not-reply@adobe.com', 'client@inovapharma.com'],
    'pm@group247ww.com'),
    ['client@inovapharma.com', 'pm@group247ww.com']);
});

check('THE PM IS ADDED EVEN IF THE LEDGER LOST THEM', () => {
  eq(S.clientRecipients(['client@inovapharma.com'], 'pm@group247ww.com'),
    ['client@inovapharma.com', 'pm@group247ww.com']);
});

check('the PM is not duplicated when already present', () => {
  eq(S.clientRecipients(['PM@group247ww.com', 'client@inovapharma.com'], 'pm@group247ww.com'),
    ['pm@group247ww.com', 'client@inovapharma.com']);
});

check('an empty ledger list yields the PM alone, never nobody', () => {
  eq(S.clientRecipients([], 'pm@group247ww.com'), ['pm@group247ww.com']);
  eq(S.clientRecipients([], ''), []);
});

suite('Retry — a client who never hears back is the failure that matters');

const CLIENT_MSG = (o) => Object.assign({
  ok: true, id: 'GM1',
  addresses: ['pulse-999@g247ww.us.monday.com', 'monday-client-relay@group247ww.com'],
  subject: 'Project - pls review & approve', syncHeader: '',
  bodyHtml: '<p>approve?</p>', bodyText: 'approve?'
}, o || {});

function clientCtx(o) {
  return Object.assign({
    route: 'client',
    anchorFor: () => ANCHOR,
    participantsFor: () => ['client@inovapharma.com', 'msalvana@group247ww.com']
  }, o || {});
}

check('a FAILED client send is retried', () => {
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    priorAttempts: { last: 'FAILED', failures: 1 }
  }));
  eq(v.relay, true, 'one retry, because not retried means the client never hears');
});

check('TWO FAILURES IS THE END — never a loop', () => {
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    priorAttempts: { last: 'FAILED', failures: 2 }
  }));
  eq(v.relay, false);
  eq(v.reason, 'retries-exhausted');
});

check('a FAILED INTERNAL send is still not retried', () => {
  // An internal message: no marker, so it routes internal.
  const v = S.shouldRelay(MSG(), clientCtx({
    route: 'internal', priorAttempts: { last: 'FAILED', failures: 1 }
  }));
  eq(v.relay, false);
  eq(v.reason, 'failed-not-retried');
});

check('"SENDING" IS NEVER RETRIED — the outcome is unknown', () => {
  // Recorded before the send. If the pass died in between, the message may
  // already be in the client's inbox and cannot be recalled.
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    priorAttempts: { last: 'sending', failures: 0 }
  }));
  eq(v.relay, false);
  eq(v.reason, 'in-flight-outcome-unknown');
});

check('a sent message is not sent twice', () => {
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    priorAttempts: { last: 'sent', failures: 0 }
  }));
  eq(v.reason, 'already-relayed');
});

check('AN EMPTY LEDGER LIST IS A LOUD SKIP, NOT A SEND TO NOBODY', () => {
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    anchorFor: () => Object.assign({}, ANCHOR, { mailbox: '' }),
    participantsFor: () => []
  }));
  eq(v.relay, false);
  // No mailbox and no participants: it fails at the anchor check first, which
  // is the correct order — an item with no thread has nowhere to go at all.
  eq(v.reason, 'item-has-no-gmail-thread');
});

suite('Self mode and the client pass end to end');

check('SELF MODE SENDS TO MARK, NOT THE CLIENT', () => {
  const r = rig({ mode: 'self', cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: CLIENT_MSG() } });
  const before = S.ROUTE;
  S.ROUTE = 'client';
  let raw = '';
  r.deps.gmail.sendRaw = (x) => { raw = x; return 'SENT1'; };
  const s = S.runRelayPass(r.deps, {});
  S.ROUTE = before;
  eq(s.relayed, 1);
  truthy(/^To: msalvana@group247ww\.com$/m.test(raw),
    'the client must not receive anything in self mode — got: ' + raw.split('\r\n')[0]);
  truthy(r.calls.indexOf('record:sent-self') !== -1,
    'and it is recorded distinctly so a self copy is never mistaken for a real one');
});

check('A LIVE CLIENT PASS ADDRESSES THE THREAD AND SETS REPLY-TO', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: CLIENT_MSG() } });
  const before = S.ROUTE;
  S.ROUTE = 'client';
  let raw = '';
  r.deps.gmail.sendRaw = (x) => { raw = x; return 'SENT1'; };
  S.runRelayPass(r.deps, {});
  S.ROUTE = before;
  truthy(/^To: client@inovapharma\.com, msalvana@group247ww\.com$/m.test(raw),
    'client and PM: ' + raw.split('\r\n')[0]);
  truthy(/^Reply-To: msalvana@group247ww\.com$/m.test(raw),
    'a client reply must land in the PM mailbox the intake reads, not projects@');
  truthy(/^In-Reply-To: <root@client\.example>$/m.test(raw), 'still threaded');
});

check('the internal route gains no Reply-To and still goes to the PM alone', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: MSG() } });
  let raw = '';
  r.deps.gmail.sendRaw = (x) => { raw = x; return 'SENT1'; };
  S.runRelayPass(r.deps, {});
  truthy(/^To: msalvana@group247ww\.com$/m.test(raw), raw.split('\r\n')[0]);
  truthy(!/^Reply-To:/m.test(raw),
    'anchored — "In-Reply-To:" contains "Reply-To:", and an unanchored test ' +
    'would report a header that is not there');
});

check('THE CLIENT RATE CAP ALERTS RATHER THAN DEFERRING QUIETLY', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: CLIENT_MSG() },
                  props: { [S.PROP_CLIENT_RATE]:
                    JSON.stringify({ windowStart: 1000000, count: S.CLIENT_MAX_PER_HOUR }) } });
  const before = S.ROUTE;
  S.ROUTE = 'client';
  const s = S.runRelayPass(r.deps, {});
  S.ROUTE = before;
  eq(s.relayed, 0);
  eq(s.rateCapped, true);
  eq(r.alerts.length, 1, 'a waiting approval request is not a silent condition');
});

check('the two routes keep SEPARATE rate budgets', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: CLIENT_MSG() },
                  props: { [S.PROP_RELAY_RATE]:
                    JSON.stringify({ windowStart: 1000000, count: S.RELAY_MAX_PER_HOUR }) } });
  const before = S.ROUTE;
  S.ROUTE = 'client';
  const s = S.runRelayPass(r.deps, {});
  S.ROUTE = before;
  eq(s.relayed, 1, 'internal chatter exhausting its budget must not block a client');
});

suite('relayHealth — looking for the absence');

check('a clean board reports ok', () => {
  const h = S.healthCheck(
    [{ route: 'client', sourceMessageId: 'A', result: 'sent' }],
    [{ id: 'A', ts: 0 }], 10 * 60 * 60 * 1000);
  eq(h.ok, true);
});

check('A SENT AUTOMATION WITH NO ROW AT ALL IS THE DEAD-RELAY SIGNAL', () => {
  const h = S.healthCheck([], [{ id: 'A', ts: 0 }], S.HEALTH_STALE_MS + 60000);
  eq(h.ok, false);
  eq(h.lost.length, 1, 'this is the only check that catches a relay that never ran');
});

check('a message younger than the window is not yet late', () => {
  const h = S.healthCheck([], [{ id: 'A', ts: 1000 }], 1000 + S.HEALTH_STALE_MS - 1);
  eq(h.ok, true);
  eq(h.lost.length, 0);
});

check('a row stuck at "sending" is reported', () => {
  const h = S.healthCheck(
    [{ route: 'client', sourceMessageId: 'A', result: 'sending' }], [], 0);
  eq(h.ok, false);
  eq(h.stuck, [{ sourceMessageId: 'A', result: 'sending' }]);
});

check('the LAST result for a source wins, so a retry that succeeded is clean', () => {
  const h = S.healthCheck([
    { route: 'client', sourceMessageId: 'A', result: 'FAILED' },
    { route: 'client', sourceMessageId: 'A', result: 'sent' }
  ], [], 0);
  eq(h.ok, true);
});

check('internal rows are not this alert’s business', () => {
  const h = S.healthCheck(
    [{ route: 'internal', sourceMessageId: 'A', result: 'FAILED' }], [], 0);
  eq(h.ok, true);
});

check('the alert text names the dead-relay case first', () => {
  const msg = S.healthMessage(S.healthCheck([], [{ id: 'A', ts: 0 }], S.HEALTH_STALE_MS + 1));
  truthy(/NOT RELAYED AT ALL/.test(msg), msg);
});

suite('The all-internal guard — the failure the audit found');

check('A THREAD WITH NO CLIENT ON IT IS NOT RELAYED', () => {
  // clientRecipients() always appends the PM, so the list is never empty and an
  // empty-list check protects nothing. Without this guard the approval request
  // goes to G247 staff, records 'sent', and the client never learns they were
  // asked. 8 of 18 audited projects are exactly this shape.
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    participantsFor: () => ['msalvana@group247ww.com', 'dnoble@group247ww.com']
  }));
  eq(v.relay, false);
  eq(v.reason, 'no-client-on-thread');
});

check('one outsider is enough', () => {
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    participantsFor: () => ['msalvana@group247ww.com', 'j.lee@inovapharma.com']
  }));
  eq(v.relay, true);
  eq(v.outsiders, ['j.lee@inovapharma.com'], 'and the outsiders are named for the log');
});

check('a blocklisted outsider does NOT count as a client', () => {
  // mailer-daemon@googlemail.com and notifications@monday.com are both live in
  // the ledger. Neither makes a thread client-reachable.
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    participantsFor: () => ['msalvana@group247ww.com', 'mailer-daemon@googlemail.com']
  }));
  eq(v.relay, false);
  eq(v.reason, 'no-client-on-thread');
});

check('THE INTERNAL ROUTE IS UNAFFECTED — it is meant to go to us', () => {
  const v = S.shouldRelay(MSG(), CTX({ route: 'internal' }));
  eq(v.relay, true, 'internal mail addressed only to G247 is the whole point of that route');
});

// ============================================ THE ROUTING LINE
suite('parseRecipientsLine — monday tells us who the client is');

const MONDAY_HTML = (line) =>
  '<div dir="ltr"><p>Please review and approve.</p>' +
  '<div style="color:#888;font-size:11px">' + line + '</div></div>';

check('THE CLIENT IS READ OUT OF THE BODY', () => {
  eq(S.parseRecipientsLine(
    MONDAY_HTML('X-G247-Recipients: n.adroja@inovapharma.com, msalvana@group247ww.com'), ''),
    ['n.adroja@inovapharma.com', 'msalvana@group247ww.com']);
});

check('HTML entities and non-breaking spaces do not break it', () => {
  eq(S.parseRecipientsLine(
    'X-G247-Recipients:&nbsp;a@inovapharma.com,&nbsp;b@inovapharma.com', ''),
    ['a@inovapharma.com', 'b@inovapharma.com']);
});

check('A TAG BOUNDARY MUST NOT GLUE TWO ADDRESSES TOGETHER', () => {
  // <b>a@x.com</b><b>b@y.com</b> flattened without a separator would read as
  // one nonsense address. Tags become spaces for exactly this reason.
  eq(S.parseRecipientsLine(
    'X-G247-Recipients: <b>a@inovapharma.com</b><b>b@inovapharma.com</b>', ''),
    ['a@inovapharma.com', 'b@inovapharma.com']);
});

check('it falls back to the plain-text part', () => {
  eq(S.parseRecipientsLine('', 'X-G247-Recipients: c@inovapharma.com'),
    ['c@inovapharma.com']);
});

check('AN ABSENT OR EMPTY LINE YIELDS NOTHING, NOT A GUESS', () => {
  eq(S.parseRecipientsLine(MONDAY_HTML('Please approve'), ''), []);
  eq(S.parseRecipientsLine('X-G247-Recipients:', ''), []);
  eq(S.parseRecipientsLine('X-G247-Recipients: {{item.text_mm3wq0mc}}', ''), [],
    'an unresolved monday placeholder is not an address');
  eq(S.parseRecipientsLine('', ''), []);
});

check('body prose after the line is not swept up as a recipient', () => {
  eq(S.parseRecipientsLine(
    'X-G247-Recipients: a@inovapharma.com\nRegards, someone@elsewhere.com', ''),
    ['a@inovapharma.com']);
});

check('duplicates collapse and case is normalised', () => {
  eq(S.parseRecipientsLine('X-G247-Recipients: A@Inova.com, a@inova.com', ''),
    ['a@inova.com']);
});

suite('stripRecipientsLine — the client must never see the plumbing');

check('THE LINE IS GONE FROM THE RELAYED BODY', () => {
  const out = S.stripRecipientsLine(
    MONDAY_HTML('X-G247-Recipients: n.adroja@inovapharma.com'));
  truthy(out.indexOf('X-G247-Recipients') === -1, 'tag leaked: ' + out);
  truthy(out.indexOf('n.adroja@inovapharma.com') === -1,
    'the distribution list leaked into the client copy: ' + out);
});

check('the real message survives intact', () => {
  const out = S.stripRecipientsLine(
    MONDAY_HTML('X-G247-Recipients: a@inovapharma.com'));
  truthy(out.indexOf('Please review and approve.') !== -1, out);
});

check('a bare inline line is stripped too', () => {
  const out = S.stripRecipientsLine('Approve please. X-G247-Recipients: a@b.com');
  eq(out.indexOf('X-G247-Recipients'), -1);
  truthy(out.indexOf('Approve please.') !== -1);
});

check('a body without the line is returned unchanged', () => {
  const body = MONDAY_HTML('Please approve');
  eq(S.stripRecipientsLine(body), body);
  eq(S.stripRecipientsLine(''), '');
});

suite('The routing line drives the send');

check('THE BODY LINE OUTRANKS THE LEDGER', () => {
  const v = S.shouldRelay(
    CLIENT_MSG({ recipientsLine: ['n.adroja@inovapharma.com'] }),
    clientCtx({ participantsFor: () => ['stale@inovapharma.com'] }));
  eq(v.relay, true);
  eq(v.recipientSource, 'body-line');
  eq(v.outsiders, ['n.adroja@inovapharma.com'],
    'monday reads it off the item at send time, so it cannot be stale');
});

check('with no line it falls back to the ledger', () => {
  const v = S.shouldRelay(CLIENT_MSG(), clientCtx({
    participantsFor: () => ['n.adroja@inovapharma.com']
  }));
  eq(v.relay, true);
  eq(v.recipientSource, 'ledger-participants');
});

check('A LINE WITH NO CLIENT ON IT IS ITS OWN SKIP REASON', () => {
  // Distinct from no-client-on-thread so the log says which mechanism failed:
  // an empty Group Email column, not an internal-only Gmail thread.
  const v = S.shouldRelay(
    CLIENT_MSG({ recipientsLine: ['msalvana@group247ww.com'] }),
    clientCtx({ participantsFor: () => ['n.adroja@inovapharma.com'] }));
  eq(v.relay, false);
  eq(v.reason, 'routing-line-has-no-client');
});

check('THE RELAYED COPY GOES OUT WITHOUT THE LINE', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: CLIENT_MSG({
                    recipientsLine: ['n.adroja@inovapharma.com'],
                    bodyHtml: MONDAY_HTML('X-G247-Recipients: n.adroja@inovapharma.com')
                  }) } });
  const before = S.ROUTE;
  S.ROUTE = 'client';
  let raw = '';
  r.deps.gmail.sendRaw = (x) => { raw = x; return 'SENT1'; };
  S.runRelayPass(r.deps, {});
  S.ROUTE = before;
  truthy(raw.indexOf('X-G247-Recipients') === -1,
    'the routing line reached the client — this is visible in their inbox');
  truthy(/^To: n\.adroja@inovapharma\.com, msalvana@group247ww\.com$/m.test(raw),
    raw.split('\r\n')[0]);
});

check('the banner names the client, never the marker', () => {
  const r = rig({ cursors: { [S.CURSOR_KEY]: 'H1' },
                  page: { messageIds: ['GM1'], newHistoryId: 'H2' },
                  messages: { GM1: CLIENT_MSG({
                    recipientsLine: ['n.adroja@inovapharma.com'] }) } });
  const before = S.ROUTE;
  S.ROUTE = 'client';
  let raw = '';
  r.deps.gmail.sendRaw = (x) => { raw = x; return 'SENT1'; };
  S.runRelayPass(r.deps, {});
  S.ROUTE = before;
  truthy(raw.indexOf('monday-client-relay@group247ww.com') === -1,
    'the marker address is internal plumbing and leaked into the body');
});

report();
