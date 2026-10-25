// Layer 1: the Code-node JavaScript, run in Node as the exact text the committed workflow gives n8n.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NOW,
  SECRET,
  USER,
  clickBody,
  fixture,
  hmacHex,
  loadWorkflow,
  node,
  runCode,
  signedClick,
} from './helpers/harness.mjs';

const wf = loadWorkflow();
const code = (name) => node(wf, name).parameters.jsCode.replaceAll('__ALLOWED_USER__', USER);

async function verify(click, now = NOW) {
  const [out] = await runCode(code('Verify+route'), { items: [click], now });
  return out.json;
}

function payload(changes = {}) {
  const p = fixture();
  return { ...p, ...changes, actions: [{ ...p.actions[0], ...(changes.action || {}) }] };
}

test('a signed approve click from the allowed user becomes one approved event', async () => {
  const r = await verify(signedClick(fixture()));
  assert.equal(r.ok, true);
  assert.deepEqual(r.event, {
    id: '1761386400.000100-U0ALLOWED',
    request: 'req-42',
    outcome: 'approved',
    by: USER,
    at: '2026-10-25T10:00:00.000Z',
  });
  assert.equal(r.response_url, fixture().response_url);
});

test('the reject button becomes a rejected event', async () => {
  const r = await verify(signedClick(payload({ action: { action_id: 'reject' } })));
  assert.equal(r.event.outcome, 'rejected');
});

test('a click signed with the wrong secret is refused', async () => {
  const r = await verify(signedClick(fixture(), { signWith: 'not-the-secret' }));
  assert.deepEqual(r, { ok: false, reason: 'bad signature' });
});

test('a click with no signature header is refused', async () => {
  const r = await verify({ ...signedClick(fixture()), signature: '' });
  assert.deepEqual(r, { ok: false, reason: 'bad signature' });
});

test('a signature of a different length is refused, not compared past its end', async () => {
  const r = await verify({ ...signedClick(fixture()), signature: 'v0=abc' });
  assert.deepEqual(r, { ok: false, reason: 'bad signature' });
});

test('a changed body fails the signature even with a valid header', async () => {
  const click = signedClick(fixture());
  const raw = click.raw.replace('req-42', 'req-43');
  const r = await verify({ ...click, raw, sig: hmacHex(SECRET, click.ts, raw) });
  assert.deepEqual(r, { ok: false, reason: 'bad signature' });
});

test('a click older than five minutes is refused as a replay', async () => {
  const r = await verify(signedClick(fixture(), { ts: NOW / 1000 - 301 }));
  assert.deepEqual(r, { ok: false, reason: 'stale timestamp' });
});

test('a click stamped more than five minutes ahead is refused too', async () => {
  const r = await verify(signedClick(fixture(), { ts: NOW / 1000 + 301 }));
  assert.deepEqual(r, { ok: false, reason: 'stale timestamp' });
});

test('a click just inside the five-minute window is accepted', async () => {
  const r = await verify(signedClick(fixture(), { ts: NOW / 1000 - 299 }));
  assert.equal(r.ok, true);
});

test('a click from anyone but the allowed user is ignored', async () => {
  const r = await verify(signedClick(payload({ user: { id: 'U0SOMEONE' } })));
  assert.deepEqual(r, { ok: false, reason: 'not the allowed user' });
});

test('an unknown button is refused', async () => {
  const r = await verify(signedClick(payload({ action: { action_id: 'delete_everything' } })));
  assert.deepEqual(r, { ok: false, reason: 'unknown button' });
});

test('a signed request that is not a button click is refused', async () => {
  const r = await verify(signedClick(payload({ type: 'view_submission' })));
  assert.deepEqual(r, { ok: false, reason: 'not a button click' });
});

test('a garbled payload is refused, not thrown', async () => {
  const raw = 'payload=%7Bnot-json';
  const ts = String(NOW / 1000);
  const sig = hmacHex(SECRET, ts, raw);
  const r = await verify({ raw, ts, signature: 'v0=' + sig, sig });
  assert.deepEqual(r, { ok: false, reason: 'not a button click' });
});

test('Raw body reads the exact bytes Slack signed and the two Slack headers', async () => {
  const raw = clickBody(fixture());
  const headers = { 'x-slack-request-timestamp': '1761386400', 'x-slack-signature': 'v0=abc', host: 'n8n.example' };
  const [out] = await runCode(code('Raw body'), { items: [{ headers, body: {} }], raw: [raw] });
  assert.deepEqual(out.json, { raw, ts: '1761386400', signature: 'v0=abc' });
});

test('Build reply replaces the Slack card with who decided what', async () => {
  const route = await verify(signedClick(fixture()));
  const [out] = await runCode(code('Build reply'), { nodes: { 'Verify+route': [route] } });
  assert.deepEqual(out.json, { replace_original: true, text: 'Request req-42 approved by <@U0ALLOWED>.' });
});
