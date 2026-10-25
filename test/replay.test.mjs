// Layer 3: a recorded click, signed the way Slack signs it, replayed against a webhook. Here the webhook is a local
// server that answers first (like the Ack node) and then runs the committed workflow, so the replay script and the
// workflow are tested together without an n8n server. Against a real n8n, run scripts/replay.mjs by hand.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fillWorkflow } from '../scripts/deploy.mjs';
import { replay, signedRequest } from '../scripts/replay.mjs';
import { SECRET, USER, fixture, hmacHex, loadWorkflow } from './helpers/harness.mjs';
import { runWorkflow } from './helpers/run_workflow.mjs';

const ENV = { SLACK_SIGNING_SECRET: SECRET, ALLOWED_USER: USER, EVENTS_URL: 'http://events.local/', EVENTS_CRED_ID: '7' };
const wf = fillWorkflow(loadWorkflow(), ENV);
let server;
let url;
let delayMs = 0;
const cards = [];
const errors = [];
let eventsDir;

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(200).end();
      const http = async (name, to, body) => {
        if (name === 'Save event') writeFileSync(join(eventsDir, `${body.id}.json`), JSON.stringify(body));
        if (name === 'Update card') cards.push({ to, body });
      };
      try {
        await runWorkflow(wf, { headers: req.headers, raw, http });
      } catch (e) {
        errors.push(e);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/webhook/approve-click`;
});

after(() => server.close());

function fresh() {
  eventsDir = mkdtempSync(join(tmpdir(), 'events-'));
  cards.length = 0;
  errors.length = 0;
  delayMs = 0;
  return eventsDir;
}

test('the request is signed exactly as Slack signs it', () => {
  const { raw, headers } = signedRequest(fixture(), SECRET, 1761386400);
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(headers['x-slack-request-timestamp'], '1761386400');
  assert.equal(headers['x-slack-signature'], 'v0=' + hmacHex(SECRET, 1761386400, raw));
  assert.equal(JSON.parse(decodeURIComponent(raw.slice('payload='.length))).actions[0].action_id, 'approve');
});

test('each replay is a new click: the action timestamp is the time of the replay', () => {
  const a = signedRequest(fixture(), SECRET, 1761386400.5);
  const action = JSON.parse(decodeURIComponent(a.raw.slice('payload='.length))).actions[0];
  assert.equal(action.action_ts, '1761386400.500000');
});

test('a replayed click passes: 200 in under a second and exactly one new event', async () => {
  const dir = fresh();
  const r = await replay({ url, fixture: fixture(), secret: SECRET, eventsDir: dir });
  assert.equal(r.pass, true, r.message);
  assert.equal(r.status, 200);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
  assert.equal(r.newEvents, 1);
  const [file] = readdirSync(dir);
  const event = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  assert.deepEqual([event.request, event.outcome, event.by], ['req-42', 'approved', USER]);
  assert.deepEqual(errors, []);
});

test('the Slack card is updated at the click response_url after the save', async () => {
  fresh();
  await replay({ url, fixture: fixture(), secret: SECRET, eventsDir });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].to, fixture().response_url);
  assert.match(cards[0].body.text, /^Request req-42 approved by <@U0ALLOWED>\.$/);
});

test('the same click signed with the wrong secret writes nothing, and --bad-sig counts that as its pass', async () => {
  const dir = fresh();
  const r = await replay({ url, fixture: fixture(), secret: SECRET, eventsDir: dir, badSig: true, waitMs: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.newEvents, 0);
  assert.equal(r.pass, true, r.message);
  assert.equal(cards.length, 0);
});

test('a webhook that writes nothing fails the replay even though it answered 200', async () => {
  const dir = fresh();
  const r = await replay({ url, fixture: fixture(), secret: 'some-other-secret', eventsDir: dir, waitMs: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.pass, false);
  assert.match(r.message, /0 new events/);
});

test('an answer slower than one second fails, even with the event written', async () => {
  const dir = fresh();
  delayMs = 1100;
  const r = await replay({ url, fixture: fixture(), secret: SECRET, eventsDir: dir });
  assert.equal(r.pass, false);
  assert.match(r.message, /over 1000 ms/);
});

test('a webhook that is down is a clear failure, not a crash', async () => {
  const r = await replay({ url: 'http://127.0.0.1:9/webhook/none', fixture: fixture(), secret: SECRET });
  assert.equal(r.pass, false);
  assert.match(r.message, /could not reach/);
});
