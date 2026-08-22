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

check('item address plus a person is the client route', () => {
  eq(S.classifyRoute(['pulse-1@g247ww.us.monday.com', 'j.lee@inovapharma.com']), 'client');
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
  anchorFor: () => ANCHOR
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
  const props = { _s: Object.assign({ [S.PROP_RELAY_MODE]: o.mode || 'on' }, o.props || {}),
                  get(k) { return this._s[k]; }, set(k, v) { this._s[k] = v; } };
  return {
    calls, cursors,
    deps: {
      gmail: {
        profile: () => 'projects@group247ww.com',
        currentHistoryId: () => 'H999',
        historyList: () => { calls.push('historyList'); return o.page || { messageIds: [], newHistoryId: 'H1000' }; },
        messageMeta: (id) => (o.messages || {})[id] || { ok: false, id },
        sendRaw: () => { calls.push('sendRaw'); if (o.sendThrows) { throw new Error(o.sendThrows); } return 'SENT1'; }
      },
      ledger: { itemThread: () => (o.anchor === undefined ? ANCHOR : o.anchor) },
      store: {
        hasRelayed: (id) => relayed.has(id),
        record: (r) => { calls.push('record:' + r.result); relayed.add(r.sourceMessageId); }
      },
      state: { getCursor: (k) => cursors[k] || '',
               setCursor: (k, v) => { cursors[k] = String(v); } },
      props,
      now: () => '2026-08-21T00:00:00.000Z',
      nowMs: () => 1000000,
      b64,
      log: () => {}
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

report();
