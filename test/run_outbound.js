'use strict';
/**
 * Outbound bridge tests.
 *
 * This is the only code in the system that can send email to a client, so the
 * bar is different: every path that decides NOT to send is tested as carefully
 * as the one that does, and the loop guard is tested against the exact identity
 * that Make's version missed.
 *
 *   node test/run_outbound.js
 */
const { loadSandbox, suite, check, eq, truthy, report } = require('./harness');
const S = loadSandbox();

const b64 = (str) => Buffer.from(str, 'utf8').toString('base64');

const ANCHOR = {
  mailbox: 'msalvana@group247ww.com',
  threadId: 'THREAD1',
  headerMessageId: 'root@client.example',
  subject: 'Homepage banner refresh'
};
const CTX = (o) => Object.assign({
  mode: 'thread',
  mailbox: 'msalvana@group247ww.com',
  anchor: ANCHOR,
  alreadySent: false,
  integrationIds: S.INTEGRATION_USER_IDS
}, o || {});
const UPD = (o) => Object.assign({
  id: '5000', creatorId: '99999999', itemId: '12345', textBody: '[client] Here is the draft.'
}, o || {});

// ===================================================================== MARKER
suite('Marker — mirroring is opt-in, never opt-out');

check('a marked update is mirrored and the marker is stripped', () => {
  const r = S.parseOutboundMarker('[client] Here is the draft.');
  eq(r.mirror, true);
  eq(r.body, 'Here is the draft.');
});

check('the marker is case-insensitive and tolerates leading whitespace', () => {
  eq(S.parseOutboundMarker('  [CLIENT]  hello').body, 'hello');
  eq(S.parseOutboundMarker('[Client] hi').mirror, true);
});

check('an unmarked update is NOT mirrored — this is the whole safety model', () => {
  eq(S.parseOutboundMarker('Migs tracker: https://docs.google.com/...').mirror, false);
  eq(S.parseOutboundMarker('@Miguel can you share the API docs').mirror, false);
  eq(S.parseOutboundMarker('').mirror, false);
  eq(S.parseOutboundMarker(null).mirror, false);
});

check('the marker must LEAD — mentioning it mid-text is not opting in', () => {
  eq(S.parseOutboundMarker('ask the [client] about this').mirror, false);
});

// ================================================================ LOOP GUARD
suite('Loop guard — the gap that would have echoed every client email');

check('an update written by ANY integration identity is never mirrored', () => {
  S.INTEGRATION_USER_IDS.forEach((id) => {
    const v = S.shouldMirrorUpdate(UPD({ creatorId: String(id) }), CTX());
    eq(v.send, false, 'integration id ' + id + ' must be filtered');
    eq(v.reason, 'written-by-integration-user');
  });
});

check('Mark (78417174) is covered — Make only filtered David (37824531)', () => {
  eq(S.shouldMirrorUpdate(UPD({ creatorId: '78417174' }), CTX()).send, false);
  eq(S.shouldMirrorUpdate(UPD({ creatorId: '37824531' }), CTX()).send, false);
});

check('the loop guard outranks the marker', () => {
  // An inbound email whose body happens to start with the marker must not be
  // mailed back to the person who sent it.
  const v = S.shouldMirrorUpdate(
    UPD({ creatorId: '78417174', textBody: '[client] please advise' }), CTX());
  eq(v.send, false);
  eq(v.reason, 'written-by-integration-user');
});

// ====================================================================== GATES
suite('Gates — every reason not to send');

check('mode off sends nothing, whatever the update says', () => {
  eq(S.shouldMirrorUpdate(UPD(), CTX({ mode: 'off' })).send, false);
  eq(S.shouldMirrorUpdate(UPD(), CTX({ mode: '' })).send, false);
  eq(S.shouldMirrorUpdate(UPD(), CTX({ mode: 'anything-else' })).send, false);
});

check('an item with no Gmail thread is skipped, not guessed at', () => {
  eq(S.shouldMirrorUpdate(UPD(), CTX({ anchor: null })).reason, 'no-gmail-thread-for-item');
  eq(S.shouldMirrorUpdate(UPD(), CTX({ anchor: { mailbox: 'x', threadId: '' } })).send, false);
});

check('only the mailbox that owns the thread sends — no five-way duplicate', () => {
  const v = S.shouldMirrorUpdate(UPD(), CTX({ mailbox: 'mdelarosa@group247ww.com' }));
  eq(v.send, false);
  eq(v.reason, 'not-this-mailbox');
});

check('an already-mirrored update is never sent twice', () => {
  eq(S.shouldMirrorUpdate(UPD(), CTX({ alreadySent: true })).reason, 'already-mirrored');
});

check('a marker with nothing after it sends no empty email', () => {
  eq(S.shouldMirrorUpdate(UPD({ textBody: '[client]   ' }), CTX()).reason, 'empty-after-marker');
});

check('a genuine client update passes every gate', () => {
  const v = S.shouldMirrorUpdate(UPD(), CTX());
  eq(v.send, true);
  eq(v.body, 'Here is the draft.');
});

// ================================================================ RECIPIENTS
suite('Recipients — read from the live thread, filtered hard');

const HEADERS = [
  'Leo Cookson <leo@pageproof.com>',
  'Mark Salvana <msalvana@group247ww.com>, notifications@monday.com',
  'noreply@mail.zapier.com, Steve <sgow@group247ww.com>',
  'Leo Cookson <leo@pageproof.com>'
];

check('self mode goes only to the mailbox owner', () => {
  eq(S.outboundRecipients(HEADERS, 'msalvana@group247ww.com', 'self'),
     ['msalvana@group247ww.com']);
});

check('thread mode dedupes, drops self, and blocks the noise addresses', () => {
  eq(S.outboundRecipients(HEADERS, 'msalvana@group247ww.com', 'thread'),
     ['leo@pageproof.com', 'sgow@group247ww.com']);
});

check('an empty or unparseable header set yields nobody, not a bad send', () => {
  eq(S.outboundRecipients([], 'me@x.com', 'thread'), []);
  eq(S.outboundRecipients(['garbage'], 'me@x.com', 'thread'), []);
});

// ====================================================================== MIME
suite('MIME — it must land IN the thread, not start a new one');

check('subject gains Re: once and only once', () => {
  eq(S.replySubject('Homepage banner'), 'Re: Homepage banner');
  eq(S.replySubject('Re: Homepage banner'), 'Re: Homepage banner');
  eq(S.replySubject('RE: Homepage banner'), 'RE: Homepage banner');
  eq(S.replySubject(''), 'Re: (no subject)');
});

check('a non-ASCII subject is RFC 2047 encoded, ASCII is left alone', () => {
  eq(S.encodeSubject('Plain subject', b64), 'Plain subject');
  truthy(S.encodeSubject('Réunion', b64).indexOf('=?UTF-8?B?') === 0);
});

check('In-Reply-To and References both carry the root Message-ID', () => {
  const raw = S.buildMirrorMime({
    to: ['leo@pageproof.com'], subject: 'Homepage banner',
    headerMessageId: 'root@client.example', itemId: '123', updateId: '5000',
    mode: 'thread', html: '<p>hi</p>'
  }, b64);
  truthy(raw.indexOf('In-Reply-To: <root@client.example>') !== -1);
  truthy(raw.indexOf('References: <root@client.example>') !== -1,
    'without References the reply starts a new thread in the recipient client');
});

check('an already-bracketed Message-ID is not double-bracketed', () => {
  const raw = S.buildMirrorMime({ to: ['a@b.c'], subject: 's',
    headerMessageId: '<root@client.example>', html: '' }, b64);
  truthy(raw.indexOf('<<') === -1);
  truthy(raw.indexOf('In-Reply-To: <root@client.example>') !== -1);
});

check('the sync header is stamped so the intake cannot re-ingest it', () => {
  const raw = S.buildMirrorMime({ to: ['a@b.c'], subject: 's',
    headerMessageId: 'r@x', itemId: '123', updateId: '5000', mode: 'self', html: '' }, b64);
  truthy(raw.indexOf(S.SYNC_HEADER_NAME + ': monday-bridge') !== -1,
    'this header is what breaks the send-ingest-send loop');
  truthy(raw.indexOf('X-G247-Item: 123') !== -1);
  truthy(raw.indexOf('X-G247-Update: 5000') !== -1);
});

check('headers and body are separated by a blank line, CRLF throughout', () => {
  const raw = S.buildMirrorMime({ to: ['a@b.c'], subject: 's',
    headerMessageId: 'r@x', html: '<p>body</p>' }, b64);
  truthy(raw.indexOf('\r\n\r\n<p>body</p>') !== -1, 'a malformed break makes the body vanish');
});

check('the body is escaped — an update is user input, not markup', () => {
  const html = S.mirrorHtml('5 < 6 & <script>alert(1)</script>', { itemId: '9' });
  truthy(html.indexOf('&lt;script&gt;') !== -1);
  truthy(html.indexOf('<script>alert') === -1);
});

// ================================================================ RATE LIMIT
suite('Rate limiter — the runaway brake');

function fakeProps(initial) {
  const store = Object.assign({}, initial || {});
  return { _store: store, get: (k) => store[k], set: (k, v) => { store[k] = v; } };
}

check('allows up to the cap, then refuses', () => {
  const p = fakeProps();
  const t0 = 1000000;
  for (let i = 0; i < S.OUTBOUND_MAX_PER_HOUR; i++) {
    const g = S.outboundRateGate(p, t0, S.OUTBOUND_MAX_PER_HOUR, 3600000);
    truthy(g.allow, 'send ' + (i + 1) + ' should be allowed');
    g.commit();
  }
  eq(S.outboundRateGate(p, t0, S.OUTBOUND_MAX_PER_HOUR, 3600000).allow, false);
});

check('a refused send does NOT consume budget', () => {
  const p = fakeProps({ [S.PROP_BRIDGE_RATE]: JSON.stringify({ windowStart: 1000, count: 20 }) });
  S.outboundRateGate(p, 1000, 20, 3600000);
  const after = JSON.parse(p.get(S.PROP_BRIDGE_RATE));
  eq(after.count, 20, 'the counter must not creep while blocked');
});

check('the window rolls over', () => {
  const p = fakeProps({ [S.PROP_BRIDGE_RATE]: JSON.stringify({ windowStart: 1000, count: 20 }) });
  eq(S.outboundRateGate(p, 1000 + 3600001, 20, 3600000).allow, true);
});

check('corrupt state fails OPEN with a fresh window, not a crash', () => {
  const p = fakeProps({ [S.PROP_BRIDGE_RATE]: 'not json' });
  eq(S.outboundRateGate(p, 5000, 20, 3600000).allow, true);
});

// ============================================================== ORCHESTRATOR
suite('runOutboundPass — sequencing, seeding and failure');

function rig(o) {
  o = o || {};
  const calls = [];
  const props = { _s: Object.assign({ [S.PROP_BRIDGE_MODE]: o.mode || 'thread' }, o.props || {}),
                  get(k) { return this._s[k]; }, set(k, v) { this._s[k] = v; } };
  const cursors = Object.assign({}, o.cursors || {});
  const sent = new Set(o.mirrored || []);
  return {
    calls,
    cursors,
    deps: {
      monday: { recentUpdates: () => { calls.push('monday.recentUpdates'); return o.updates || []; } },
      gmail: {
        getProfileEmail: () => 'msalvana@group247ww.com',
        threadAddresses: () => ['Leo <leo@pageproof.com>'],
        sendRaw: (raw, tid) => {
          calls.push('gmail.sendRaw');
          if (o.sendThrows) { throw new Error(o.sendThrows); }
          return 'GMAILSENT1';
        }
      },
      ledger: {
        itemThread: (id) => (o.anchors && o.anchors[id]) || ANCHOR,
        hasMirrored: (id) => sent.has(String(id)),
        stageMirrored: (r) => { calls.push('ledger.stageMirrored'); sent.add(String(r.updateId)); },
        flush: () => { calls.push('ledger.flush'); return 1; }
      },
      state: {
        getCursor: (k) => cursors[k] || '',
        setCursor: (k, v) => { cursors[k] = String(v); calls.push('state.setCursor:' + v); }
      },
      props,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => '2026-08-21T00:00:00.000Z',
      nowMs: () => 1000000,
      b64
    }
  };
}

check('mode off does not even ask monday for updates', () => {
  const r = rig({ mode: 'off', updates: [UPD()] });
  const sum = S.runOutboundPass(r.deps, {});
  eq(r.calls.length, 0, 'an off bridge must cost nothing at all');
  eq(sum.sent, 0);
});

check('THE FIRST RUN SEEDS AND SENDS NOTHING', () => {
  const r = rig({ updates: [UPD({ id: '5000' }), UPD({ id: '5100' })] });
  const sum = S.runOutboundPass(r.deps, {});
  eq(sum.seeded, true);
  eq(sum.sent, 0, 'otherwise turning it on mails every historical marked update');
  eq(r.cursors[S.OUTBOUND_CURSOR_KEY], '5100', 'cursor lands on the newest update');
  eq(r.calls.filter((c) => c === 'gmail.sendRaw').length, 0);
});

check('only updates newer than the cursor are considered', () => {
  const r = rig({
    cursors: { [S.OUTBOUND_CURSOR_KEY]: '5000' },
    updates: [UPD({ id: '4900' }), UPD({ id: '5000' }), UPD({ id: '5001' })]
  });
  const sum = S.runOutboundPass(r.deps, {});
  eq(sum.sent, 1, 'the two at or below the cursor are already done');
  eq(r.cursors[S.OUTBOUND_CURSOR_KEY], '5001');
});

check('THE LEDGER ROW IS WRITTEN BEFORE THE SEND', () => {
  const r = rig({ cursors: { [S.OUTBOUND_CURSOR_KEY]: '1' }, updates: [UPD({ id: '5001' })] });
  S.runOutboundPass(r.deps, {});
  const stage = r.calls.indexOf('ledger.stageMirrored');
  const flush = r.calls.indexOf('ledger.flush');
  const send = r.calls.indexOf('gmail.sendRaw');
  truthy(stage > -1 && flush > stage && send > flush,
    'inverse of the intake rule: a duplicate email cannot be recalled, a lost one can be resent');
});

check('a failed send is NOT retried and does not throw', () => {
  const r = rig({ cursors: { [S.OUTBOUND_CURSOR_KEY]: '1' },
                  updates: [UPD({ id: '5001' })], sendThrows: 'gmail exploded' });
  const sum = S.runOutboundPass(r.deps, {});
  eq(sum.failed, 1);
  eq(sum.sent, 0);
  eq(r.cursors[S.OUTBOUND_CURSOR_KEY], '5001', 'cursor moves past it — no retry loop at a client');
});

check('updates are processed oldest first', () => {
  const seenOrder = [];
  const r = rig({
    cursors: { [S.OUTBOUND_CURSOR_KEY]: '1' },
    updates: [UPD({ id: '5003' }), UPD({ id: '5001' }), UPD({ id: '5002' })]
  });
  r.deps.ledger.stageMirrored = (rec) => seenOrder.push(rec.updateId);
  S.runOutboundPass(r.deps, {});
  eq(seenOrder, ['5001', '5002', '5003']);
});

check('a dry run sends nothing but still reports what it would have done', () => {
  const r = rig({ cursors: { [S.OUTBOUND_CURSOR_KEY]: '1' }, updates: [UPD({ id: '5001' })] });
  const sum = S.runOutboundPass(r.deps, { dryRun: true });
  eq(r.calls.filter((c) => c === 'gmail.sendRaw').length, 0);
  eq(r.calls.filter((c) => c === 'ledger.stageMirrored').length, 0);
  eq(sum.sent, 0);
});

check('hitting the rate cap stops the run WITHOUT skipping the deferred update', () => {
  const r = rig({
    cursors: { [S.OUTBOUND_CURSOR_KEY]: '1' },
    updates: [UPD({ id: '5001' }), UPD({ id: '5002' })],
    props: { [S.PROP_BRIDGE_RATE]: JSON.stringify({ windowStart: 1000000, count: 999 }) }
  });
  const sum = S.runOutboundPass(r.deps, {});
  eq(sum.sent, 0);
  eq(r.cursors[S.OUTBOUND_CURSOR_KEY], '1',
    'the cursor stays put — mail we deliberately did not send must be retried next window');
});

check('skipped updates still advance the cursor — they are decided, not pending', () => {
  const r = rig({
    cursors: { [S.OUTBOUND_CURSOR_KEY]: '1' },
    updates: [UPD({ id: '5001', textBody: 'internal chatter, no marker' })]
  });
  const sum = S.runOutboundPass(r.deps, {});
  eq(sum.skipped, 1);
  eq(sum.reasons['no-marker'], 1);
  eq(r.cursors[S.OUTBOUND_CURSOR_KEY], '5001');
});


// ================================================================ MESSAGE-ID
suite('Message-ID case — the difference between a dedup key and a header');

check('bareMessageId strips brackets and preserves case', () => {
  eq(S.bareMessageId('<CAAcrCBgAbM3Eg3bK8nr0vTwqZid=S-ATPowzJpWnnHrop7YkZg@mail.gmail.com>'),
     'CAAcrCBgAbM3Eg3bK8nr0vTwqZid=S-ATPowzJpWnnHrop7YkZg@mail.gmail.com');
  eq(S.bareMessageId('  <a@b.c>  '), 'a@b.c');
  eq(S.bareMessageId(''), '');
  eq(S.bareMessageId(null), '');
});

check('normalizeMessageId still lowercases — dedup keys must not change', () => {
  eq(S.normalizeMessageId('<AbC@Mail.Gmail.Com>'), 'abc@mail.gmail.com',
    'every ledger key ever written is lowercased; changing this orphans them all');
});

check('the two differ exactly where it matters', () => {
  const real = 'CAAcrCBgAbM3Eg3bK8nr0vTwqZid=S-ATPowzJpWnnHrop7YkZg@mail.gmail.com';
  truthy(S.normalizeMessageId(real) !== real, 'the key is flattened');
  eq(S.bareMessageId(real), real, 'the header value is not');
});


report();
