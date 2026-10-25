// Code-node logic for the "Approve click" workflow. n8n gets this file's text plus one call line per Code node
// (scripts/build.mjs writes them into workflows/approve-click.json); the tests run that same text in Node.
// Plain functions only: a Code node can't import or export.

const MAX_AGE_S = 300; // Slack's advice: refuse requests more than five minutes from now, so old ones can't be replayed
const OUTCOMES = { approve: 'approved', reject: 'rejected' };

// Compares every character, so the time taken doesn't tell an attacker how much of a signature was right.
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Slack posts a button click as a form: payload=<url-encoded JSON>.
function parsePayload(raw) {
  const m = /(?:^|&)payload=([^&]*)/.exec(raw || '');
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(m[1].replace(/\+/g, ' ')));
  } catch (e) {
    return null;
  }
}

// click: the raw body and Slack's two headers (Raw body node) plus `sig`, the HMAC the Sign node computed.
function verifyAndRoute(click, nowMs, allowedUser) {
  const ts = Number(click.ts);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > MAX_AGE_S) return { ok: false, reason: 'stale timestamp' };
  if (!click.sig || !sameText(click.signature, 'v0=' + click.sig)) return { ok: false, reason: 'bad signature' };
  const p = parsePayload(click.raw);
  if (!p || p.type !== 'block_actions' || !Array.isArray(p.actions) || !p.actions.length) {
    return { ok: false, reason: 'not a button click' };
  }
  const user = (p.user || {}).id;
  if (user !== allowedUser) return { ok: false, reason: 'not the allowed user' };
  const action = p.actions[0];
  const outcome = OUTCOMES[action.action_id];
  if (!outcome) return { ok: false, reason: 'unknown button' };
  return {
    ok: true,
    response_url: p.response_url,
    event: {
      id: `${action.action_ts}-${user}`,
      request: action.value,
      outcome,
      by: user,
      at: new Date(nowMs).toISOString(),
    },
  };
}

function buildReply(route) {
  const e = route.event;
  return { replace_original: true, text: `Request ${e.request} ${e.outcome} by <@${e.by}>.` };
}

// One entry point per Code node.
async function nodeRawBody(items, helpers) {
  const h = items[0].json.headers || {};
  const raw = (await helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
  return [{ json: { raw, ts: h['x-slack-request-timestamp'] || '', signature: h['x-slack-signature'] || '' } }];
}

function nodeVerifyRoute(items, nowMs, allowedUser) {
  return [{ json: verifyAndRoute(items[0].json, nowMs, allowedUser) }];
}

function nodeBuildReply(route) {
  return [{ json: buildReply(route) }];
}
