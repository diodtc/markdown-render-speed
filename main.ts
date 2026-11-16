// Driver for the markdown-render-speed entry. The harness runs
// `node /bot/main.ts` with the cases at $MAKEFUN_INPUT_DIR/cases.json
// (default /input) and expects the rendered HTML strings at
// $MAKEFUN_OUTPUT_DIR/html.json (default /output), one per case, in order.
// Each case is rendered on its own, so no state leaks between cases.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case { id: string; markdown: string }

const cases: Case[] = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
