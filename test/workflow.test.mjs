// Layer 2: the workflow JSON as committed, before anything is deployed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWorkflow } from '../scripts/build.mjs';
import { PLACEHOLDERS } from '../scripts/deploy.mjs';
import { loadWorkflow, node } from './helpers/harness.mjs';

const wf = loadWorkflow();
const ORDER = ['Slack click', 'Ack', 'Raw body', 'Sign', 'Verify+route', 'Valid?', 'Save event', 'Build reply', 'Update card'];
const ALLOWED_TYPES = new Set(['webhook', 'respondToWebhook', 'code', 'crypto', 'if', 'httpRequest']);

// [[target names] per output] of one node.
const outputs = (name) => (wf.connections[name]?.main || []).map((out) => out.map((c) => c.node));

test('the nodes and their order', () => {
  assert.deepEqual(
    wf.nodes.map((n) => n.name),
    ORDER,
  );
});

test('only the node types this workflow needs', () => {
  for (const n of wf.nodes) {
    assert.ok(ALLOWED_TYPES.has(n.type.replace('n8n-nodes-base.', '')), `${n.name}: ${n.type}`);
  }
});

test('the webhook takes POSTs, keeps the raw body and lets a later node answer', () => {
  const p = node(wf, 'Slack click').parameters;
  assert.deepEqual([p.httpMethod, p.path, p.responseMode, p.options.rawBody], ['POST', 'approve-click', 'responseNode', true]);
});

test('Slack gets its answer first, with no data, before any work', () => {
  assert.deepEqual(outputs('Slack click'), [['Ack']]);
  const ack = node(wf, 'Ack');
  assert.equal(ack.type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(ack.parameters.respondWith, 'noData');
  assert.deepEqual(outputs('Ack'), [['Raw body']]);
});

test('Sign is an HMAC-SHA256 of "v0:timestamp:body", as Slack signs it', () => {
  const p = node(wf, 'Sign').parameters;
  assert.deepEqual(
    [p.action, p.type, p.encoding, p.dataPropertyName],
    ['hmac', 'SHA256', 'hex', 'sig'],
  );
  assert.equal(p.value, "={{ 'v0:' + $json.ts + ':' + $json.raw }}");
});

test('only a valid click is saved, and the card is updated after the save', () => {
  assert.deepEqual(outputs('Raw body'), [['Sign']]);
  assert.deepEqual(outputs('Sign'), [['Verify+route']]);
  assert.deepEqual(outputs('Verify+route'), [['Valid?']]);
  assert.deepEqual(outputs('Valid?'), [['Save event'], []]);
  assert.deepEqual(outputs('Save event'), [['Build reply']]);
  assert.deepEqual(outputs('Build reply'), [['Update card']]);
  const cond = node(wf, 'Valid?').parameters.conditions.conditions;
  assert.equal(cond.length, 1);
  assert.equal(cond[0].leftValue, '={{ $json.ok }}');
  assert.equal(cond[0].operator.operation, 'true');
});

test('the save sends the event and nothing else', () => {
  const p = node(wf, 'Save event').parameters;
  assert.deepEqual([p.method, p.url, p.jsonBody], ['POST', '__EVENTS_URL__', '={{ JSON.stringify($json.event) }}']);
});

test('the card update goes back to the response_url of the click', () => {
  const p = node(wf, 'Update card').parameters;
  assert.equal(p.url, "={{ $('Verify+route').first().json.response_url }}");
});

test('credentials are referenced by name, with the id left for the deploy script', () => {
  const used = wf.nodes.filter((n) => n.credentials).map((n) => [n.name, n.credentials]);
  assert.deepEqual(used, [['Save event', { httpHeaderAuth: { id: '__EVENTS_CRED_ID__', name: 'Events API' } }]]);
});

test('no secret, user id or URL of a real system is committed: only placeholders', () => {
  const text = JSON.stringify(wf);
  for (const token of Object.keys(PLACEHOLDERS)) assert.ok(text.includes(token), `${token} is used`);
  const found = text.match(/__[A-Z_]+__/g);
  assert.deepEqual([...new Set(found)].sort(), Object.keys(PLACEHOLDERS).sort());
  assert.doesNotMatch(text, /xox[abp]-|[0-9a-f]{32,}|hooks\.slack\.com/);
});

test('every Code node is exactly what the build makes from logic/, so n8n runs the tested code', () => {
  assert.deepEqual(buildWorkflow(wf), wf);
});

test('workflow settings: v1 execution order and no saved data on success', () => {
  assert.equal(wf.settings.executionOrder, 'v1');
  assert.equal(wf.settings.saveDataSuccessExecution, 'none');
});
