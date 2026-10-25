// Layer 4: deploys run from a script against the n8n public API. Here the API is a small fake that keeps
// workflows in memory and can be told to fail, so the script's create, update and error paths all run.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { deploy, dryRun, fillWorkflow, loadEnv } from '../scripts/deploy.mjs';
import { loadWorkflow } from './helpers/harness.mjs';

const KEY = 'n8n-api-key-for-tests';
const SIGNING = 'signing-secret-for-tests';
let server;
let base;
let store; // id -> workflow
let calls;
let failWith; // {status, body} for the next write

function env() {
  return {
    N8N_URL: base,
    N8N_API_KEY: KEY,
    SLACK_SIGNING_SECRET: SIGNING,
    ALLOWED_USER: 'U0ALLOWED',
    EVENTS_URL: 'https://events.example/inbox',
    EVENTS_CRED_ID: '12',
  };
}

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, key: req.headers['x-n8n-api-key'] });
      const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['x-n8n-api-key'] !== KEY) return send(401, { message: 'unauthorized' });
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      if (failWith && req.method !== 'GET') return send(failWith.status, failWith.body);
      if (req.method === 'GET' && req.url.startsWith('/api/v1/workflows')) {
        return send(200, { data: Object.entries(store).map(([id, w]) => ({ id, name: w.name })), nextCursor: null });
      }
      if (req.method === 'POST' && req.url === '/api/v1/workflows') {
        const id = `wf${Object.keys(store).length + 1}`;
        store[id] = body;
        return send(200, { id, ...body });
      }
      const m = /^\/api\/v1\/workflows\/(\w+)$/.exec(req.url);
      if (req.method === 'PUT' && m && store[m[1]]) {
        store[m[1]] = body;
        return send(200, { id: m[1], ...body });
      }
      return send(404, { message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  store = {};
  calls = [];
  failWith = null;
});

const quiet = () => {
  const lines = [];
  return { lines, log: (s) => lines.push(s) };
};

test('the first deploy creates the workflow with every placeholder filled', async () => {
  const { log } = quiet();
  const r = await deploy({ wf: loadWorkflow(), env: env(), log });
  assert.deepEqual(r, { action: 'created', id: 'wf1' });
  const sent = JSON.stringify(store.wf1);
  assert.doesNotMatch(sent, /__[A-Z_]+__/);
  assert.ok(sent.includes(SIGNING) && sent.includes('U0ALLOWED') && sent.includes('https://events.example/inbox'));
  assert.deepEqual(Object.keys(store.wf1).sort(), ['connections', 'name', 'nodes', 'settings']);
});

test('a second deploy updates the same workflow by name: no "(copy)"', async () => {
  const { log } = quiet();
  await deploy({ wf: loadWorkflow(), env: env(), log });
  const r = await deploy({ wf: loadWorkflow(), env: env(), log });
  assert.deepEqual(r, { action: 'updated', id: 'wf1' });
  assert.deepEqual(Object.keys(store), ['wf1']);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET', 'POST', 'GET', 'PUT'],
  );
});

test('two workflows with the same name stop the deploy instead of guessing', async () => {
  store = { a: { name: 'Approve click' }, b: { name: 'Approve click' } };
  await assert.rejects(deploy({ wf: loadWorkflow(), env: env(), log: () => {} }), /2 workflows named "Approve click"/);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET'],
  );
});

test('the committed file is never changed by a deploy', async () => {
  const before = readFileSync(new URL('../workflows/approve-click.json', import.meta.url), 'utf8');
  await deploy({ wf: loadWorkflow(), env: env(), log: () => {} });
  const after = readFileSync(new URL('../workflows/approve-click.json', import.meta.url), 'utf8');
  assert.equal(after, before);
});

test('an error that echoes the key and the secret back is printed without them', async () => {
  failWith = { status: 400, body: { message: `bad request: key ${KEY} secret ${SIGNING}` } };
  const { lines, log } = quiet();
  const err = await deploy({ wf: loadWorkflow(), env: env(), log }).catch((e) => e);
  assert.ok(err instanceof Error);
  const shown = err.message + lines.join('\n');
  assert.match(err.message, /n8n answered 400/);
  assert.ok(!shown.includes(KEY) && !shown.includes(SIGNING), shown);
  assert.match(err.message, /<N8N_API_KEY>/);
});

test('the output names ids and actions only, never a value from .env', async () => {
  const { lines, log } = quiet();
  await deploy({ wf: loadWorkflow(), env: env(), log });
  const text = lines.join('\n');
  assert.match(text, /created wf1/);
  for (const v of [KEY, SIGNING, 'https://events.example/inbox']) assert.ok(!text.includes(v), v);
});

test('a missing .env value stops the deploy and names the key only', async () => {
  const e = { ...env(), SLACK_SIGNING_SECRET: '' };
  await assert.rejects(deploy({ wf: loadWorkflow(), env: e, log: () => {} }), /missing in \.env: SLACK_SIGNING_SECRET$/);
  assert.equal(calls.length, 0);
});

test('a dry run shows each value as <NAME from .env> and calls nothing', () => {
  const text = dryRun(loadWorkflow());
  assert.match(text, /<SLACK_SIGNING_SECRET from \.env>/);
  assert.match(text, /<EVENTS_CRED_ID from \.env>/);
  assert.doesNotMatch(text, /__[A-Z_]+__/);
  assert.equal(calls.length, 0);
});

test('placeholders are filled inside strings without breaking the JSON', () => {
  const wf = fillWorkflow(loadWorkflow(), { ...env(), SLACK_SIGNING_SECRET: 'quote"and\\slash' });
  const sign = wf.nodes.find((n) => n.name === 'Sign');
  assert.equal(sign.parameters.secret, 'quote"and\\slash');
});

test('.env is read as KEY=value lines; comments and blanks are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-'));
  const path = join(dir, '.env');
  writeFileSync(path, '# n8n\nN8N_URL=http://localhost:5678\n\nN8N_API_KEY = abc=def \n');
  assert.deepEqual(loadEnv(path), { N8N_URL: 'http://localhost:5678', N8N_API_KEY: 'abc=def' });
});
