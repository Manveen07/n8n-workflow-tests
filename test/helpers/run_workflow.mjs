// Runs the committed workflow for one webhook request, node by node, with small stand-ins for the six n8n node types
// it uses. Code nodes run their exact jsCode; HTTP Request nodes call `http(nodeName, url, body)` instead of the
// network. Enough to replay a click end to end without an n8n server; it is not a general n8n engine.
import { createHmac } from 'node:crypto';
import { runCode } from './harness.mjs';

function expr(value, json, $) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const m = /^=\{\{([\s\S]*)\}\}$/.exec(value.trim());
  if (!m) throw new Error(`unsupported expression: ${value}`);
  return new Function('$json', '$', `return (${m[1]});`)(json, $);
}

export async function runWorkflow(wf, { headers, raw, now = Date.now(), onAck = () => {}, http }) {
  const out = {}; // node name -> output json list
  const $ = (name) => {
    const xs = (out[name] || []).map((json) => ({ json }));
    return { all: () => xs, first: () => xs[0] };
  };
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const start = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  const queue = [[start, [{ json: { headers, body: {} } }]]];
  while (queue.length) {
    const [n, items] = queue.shift();
    const type = n.type.replace('n8n-nodes-base.', '');
    const p = n.parameters;
    let branches; // items per output
    if (type === 'webhook') {
      branches = [items];
    } else if (type === 'respondToWebhook') {
      onAck();
      branches = [items];
    } else if (type === 'code') {
      branches = [await runCode(p.jsCode, { items, nodes: out, raw: [raw], now })];
    } else if (type === 'crypto') {
      if (p.action !== 'hmac' || p.type !== 'SHA256' || p.encoding !== 'hex') throw new Error(`${n.name}: unsupported`);
      branches = [
        items.map((it) => {
          const sig = createHmac('sha256', p.secret).update(String(expr(p.value, it.json, $))).digest('hex');
          return { json: { ...it.json, [p.dataPropertyName]: sig } };
        }),
      ];
    } else if (type === 'if') {
      const [c] = p.conditions.conditions;
      if (p.conditions.conditions.length !== 1 || c.operator.operation !== 'true') throw new Error(`${n.name}: unsupported`);
      const pass = (it) => expr(c.leftValue, it.json, $) === true;
      branches = [items.filter(pass), items.filter((it) => !pass(it))];
    } else if (type === 'httpRequest') {
      branches = [[]];
      for (const it of items) {
        const body = JSON.parse(expr(p.jsonBody, it.json, $));
        branches[0].push({ json: (await http(n.name, expr(p.url, it.json, $), body)) || {} });
      }
    } else {
      throw new Error(`${n.name}: no stand-in for ${n.type}`);
    }
    out[n.name] = branches[0].map((it) => it.json);
    (wf.connections[n.name]?.main || []).forEach((targets, i) => {
      const its = branches[i] || [];
      if (its.length) for (const t of targets) queue.push([byName[t.node], its]);
    });
  }
  return out;
}
