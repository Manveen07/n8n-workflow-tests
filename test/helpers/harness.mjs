// Runs n8n Code-node JavaScript in Node the way a Code node runs it: the same text, with the globals a Code node
// sees ($input, $, $json, $runIndex, this.helpers) faked from plain data. Date is pinned so tests are repeatable.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ROOT = new URL('../../', import.meta.url);
export const SECRET = 'test-signing-secret';
export const USER = 'U0ALLOWED';
export const NOW = Date.parse('2026-10-25T10:00:00Z');

export function loadWorkflow(name = 'approve-click') {
  return JSON.parse(readFileSync(new URL(`workflows/${name}.json`, ROOT), 'utf8'));
}

export function node(wf, name) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named ${name}`);
  return n;
}

export function fixture(name = 'click-approve') {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, ROOT), 'utf8'));
}

const AsyncFunction = (async () => {}).constructor;
const wrap = (xs) => xs.map((x) => (x && x.json ? x : { json: x }));
const access = (xs) => ({ all: () => xs, first: () => xs[0], last: () => xs[xs.length - 1], item: xs[0] });

export async function runCode(jsCode, { items = [], nodes = {}, raw = [], now = NOW } = {}) {
  const its = wrap(items);
  const $ = (name) => access(wrap(nodes[name] || []));
  const helpers = { getBinaryDataBuffer: async (i) => Buffer.from(raw[i] ?? '', 'utf8') };
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const body = new AsyncFunction('$input', '$', '$json', '$runIndex', 'Date', jsCode);
  return body.call({ helpers }, access(its), $, its[0] && its[0].json, 0, FixedDate);
}

// Slack's request signature: "v0=" + HMAC-SHA256 of "v0:<timestamp>:<raw body>" with the app's signing secret.
export function hmacHex(secret, ts, raw) {
  return createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
}

export function clickBody(payload) {
  return 'payload=' + encodeURIComponent(JSON.stringify(payload));
}

// What the Verify+route node receives: Raw body's fields plus the HMAC the Sign node added as `sig`.
export function signedClick(payload, { secret = SECRET, signWith = secret, ts = NOW / 1000 } = {}) {
  const raw = clickBody(payload);
  return { raw, ts: String(ts), signature: 'v0=' + hmacHex(signWith, ts, raw), sig: hmacHex(secret, ts, raw) };
}
