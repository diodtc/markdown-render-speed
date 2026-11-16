// Driver for the markdown-render-speed entry: reads every case from
// $MAKEFUN_INPUT_DIR/cases.json, renders each one alone with parse() from
// parse.js, and writes the HTML strings in order to
// $MAKEFUN_OUTPUT_DIR/html.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = [];
for (const c of cases) html.push(parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
