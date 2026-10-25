// Replays a recorded Slack click against the webhook, signed the way Slack signs it, and checks the result.
// Pass: HTTP 200 in under a second (Slack allows 3) and exactly one new event file. With --bad-sig the click is
// signed with a wrong secret, and the pass is the opposite: no new event.
//   node scripts/replay.mjs --url <webhook url> [--events-dir <folder the events endpoint writes to>] [--bad-sig]
//                           [--fixture fixtures/click-approve.json] [--env .env]
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './deploy.mjs';

const ROOT = new URL('../', import.meta.url);
const LIMIT_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each replay is a new click: the action timestamp (part of the event id) is the time of the replay.
export function signedRequest(fixture, secret, nowS) {
  const payload = structuredClone(fixture);
  payload.actions[0].action_ts = nowS.toFixed(6);
  const raw = 'payload=' + encodeURIComponent(JSON.stringify(payload));
  const ts = String(Math.floor(nowS));
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  return {
    raw,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
  };
}

export async function replay({ url, fixture, secret, eventsDir, badSig = false, waitMs = 2000 }) {
  const count = () => readdirSync(eventsDir).length;
  const before = eventsDir ? count() : 0;
  const { raw, headers } = signedRequest(fixture, badSig ? `${secret}-wrong` : secret, Date.now() / 1000);
  const t0 = performance.now();
  let status;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: raw });
    await res.arrayBuffer();
    status = res.status;
  } catch (e) {
    return { pass: false, status: 0, ms: 0, newEvents: 0, message: `could not reach ${url}: ${e.cause?.code || e.message}` };
  }
  const ms = Math.round(performance.now() - t0);

  let newEvents = null;
  if (eventsDir) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && count() === before) await sleep(50);
    if (count() > before) await sleep(200); // long enough to catch a second, duplicate write
    newEvents = count() - before;
  }

  const problems = [];
  if (status !== 200) problems.push(`status ${status}`);
  if (ms >= LIMIT_MS) problems.push(`${ms} ms, over ${LIMIT_MS} ms`);
  if (newEvents !== null && newEvents !== (badSig ? 0 : 1)) {
    problems.push(`${newEvents} new events, expected ${badSig ? 'none for a wrong signature' : 'exactly 1'}`);
  }
  const events = newEvents === null ? 'events not checked (no --events-dir)' : `${newEvents} new events`;
  const message = problems.length
    ? `FAIL: ${problems.join('; ')}`
    : `PASS: ${badSig ? 'wrong secret, ' : ''}${status} in ${ms} ms, ${events}`;
  return { pass: !problems.length, status, ms, newEvents, message };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const url = opt('--url');
  if (!url) {
    console.error('usage: node scripts/replay.mjs --url <webhook url> [--events-dir DIR] [--bad-sig]');
    process.exit(2);
  }
  const env = loadEnv(opt('--env', fileURLToPath(new URL('.env', ROOT))));
  if (!env.SLACK_SIGNING_SECRET) {
    console.error('missing in .env: SLACK_SIGNING_SECRET');
    process.exit(2);
  }
  const fixture = JSON.parse(readFileSync(opt('--fixture', fileURLToPath(new URL('fixtures/click-approve.json', ROOT))), 'utf8'));
  const r = await replay({
    url,
    fixture,
    secret: env.SLACK_SIGNING_SECRET,
    eventsDir: opt('--events-dir'),
    badSig: args.includes('--bad-sig'),
  });
  console.log(r.message);
  process.exit(r.pass ? 0 : 1);
}
