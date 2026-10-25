// Creates or updates the "Approve click" workflow in n8n through its public API, by name, so running it twice
// never leaves a "(copy)". Values come from .env and are never printed: output is the action and the workflow id.
//   node scripts/deploy.mjs [--env path/to/.env]
//   node scripts/deploy.mjs --dry-run   print what would be sent, each value shown as <NAME from .env>; no network
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

// Placeholder in workflows/approve-click.json -> the .env key that fills it at deploy time
export const PLACEHOLDERS = {
  __SLACK_SIGNING_SECRET__: 'SLACK_SIGNING_SECRET',
  __ALLOWED_USER__: 'ALLOWED_USER',
  __EVENTS_URL__: 'EVENTS_URL',
  __EVENTS_CRED_ID__: 'EVENTS_CRED_ID',
};
const KEYS = ['N8N_URL', 'N8N_API_KEY', ...Object.values(PLACEHOLDERS)];

export function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

const fill = (wf, valueOf) =>
  mapStrings(wf, (s) => s.replace(/__[A-Z_]+__/g, (token) => (token in PLACEHOLDERS ? valueOf(PLACEHOLDERS[token]) : token)));

export function fillWorkflow(wf, env) {
  return fill(wf, (key) => env[key]);
}

export function dryRun(wf) {
  return JSON.stringify(fill(wf, (key) => `<${key} from .env>`), null, 2);
}

// Every .env value in `text` replaced by <ITS_NAME>, longest first, so an error body can be shown safely.
export function scrub(text, env) {
  const pairs = Object.entries(env)
    .filter(([, v]) => v && v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  return pairs.reduce((t, [k, v]) => t.split(v).join(`<${k}>`), String(text));
}

export async function deploy({ wf, env, fetchImpl = fetch, log = console.log }) {
  const missing = KEYS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing in .env: ${missing.join(', ')}`);
  const api = `${env.N8N_URL.replace(/\/$/, '')}/api/v1`;
  async function call(method, path, body) {
    const res = await fetchImpl(api + path, {
      method,
      headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`n8n answered ${res.status} to ${method} ${path}: ${scrub(text, env).slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  const same = [];
  let cursor = '';
  do {
    const page = await call('GET', `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    same.push(...page.data.filter((w) => w.name === wf.name));
    cursor = page.nextCursor;
  } while (cursor);
  if (same.length > 1) throw new Error(`${same.length} workflows named "${wf.name}" in n8n: delete the copies first`);

  const filled = fillWorkflow(wf, env);
  const body = { name: filled.name, nodes: filled.nodes, connections: filled.connections, settings: filled.settings };
  const result = same.length
    ? { action: 'updated', id: (await call('PUT', `/workflows/${same[0].id}`, body)).id }
    : { action: 'created', id: (await call('POST', '/workflows', body)).id };
  log(`${result.action} ${result.id} "${wf.name}"`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const wf = JSON.parse(readFileSync(new URL('workflows/approve-click.json', ROOT), 'utf8'));
  if (args.includes('--dry-run')) {
    console.log(dryRun(wf));
  } else {
    const i = args.indexOf('--env');
    const envPath = i >= 0 ? args[i + 1] : fileURLToPath(new URL('.env', ROOT));
    try {
      await deploy({ wf, env: loadEnv(envPath) });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}
