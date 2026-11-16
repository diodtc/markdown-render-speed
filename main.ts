// Driver for the markdown-render-speed entry. The harness runs
// `node /bot/main.ts` under Node 22. It reads every case from
// <input>/cases.json (a JSON array of {id, markdown}), renders each case
// alone through parse() from ./parse.js, and writes <output>/html.json:
// a JSON array of the HTML strings, one per case, in case order.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output
// when the driver runs outside the grading container.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function loadCases(path: string): { id: string; markdown: string }[] {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function renderAll(cases: { id: string; markdown: string }[]): string[] {
  const out: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
  return out;
}

const cases = loadCases(join(inputDir, 'cases.json'));
const html = renderAll(cases);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
