// Writes each Code node's JavaScript into workflows/approve-click.json: the text of logic/approve_click.js plus the
// one line that calls that node's entry point. The tests run the same text, so n8n always runs the tested code.
//   node scripts/build.mjs           rewrite the Code nodes
//   node scripts/build.mjs --check   exit 1 if the committed workflow differs from a fresh build
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const LOGIC = new URL('logic/approve_click.js', ROOT);
const WORKFLOW = new URL('workflows/approve-click.json', ROOT);

// Code node -> the line that calls its entry point in logic/approve_click.js
export const CODE_NODES = {
  'Raw body': 'return await nodeRawBody($input.all(), this.helpers);',
  'Verify+route': "return nodeVerifyRoute($input.all(), Date.now(), '__ALLOWED_USER__');",
  'Build reply': "return nodeBuildReply($('Verify+route').first().json);",
};

export function buildCode(name) {
  return `${readFileSync(LOGIC, 'utf8').trimEnd()}\n\n${CODE_NODES[name]}\n`;
}

export function buildWorkflow(wf) {
  const out = structuredClone(wf);
  for (const n of out.nodes) {
    if (n.type !== 'n8n-nodes-base.code') continue;
    if (!CODE_NODES[n.name]) throw new Error(`Code node "${n.name}" has no entry in CODE_NODES`);
    n.parameters.jsCode = buildCode(n.name);
  }
  return out;
}

const asText = (wf) => `${JSON.stringify(wf, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = readFileSync(WORKFLOW, 'utf8');
  const built = asText(buildWorkflow(JSON.parse(current)));
  if (process.argv.includes('--check')) {
    if (built !== current) {
      console.error('workflows/approve-click.json differs from logic/: run node scripts/build.mjs');
      process.exit(1);
    }
    console.log('workflows/approve-click.json matches logic/');
  } else {
    writeFileSync(WORKFLOW, built);
    console.log(built === current ? 'unchanged' : 'rebuilt workflows/approve-click.json');
  }
}
