# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/diodtc/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/diodtc/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown parser for Node 22 that renders exactly the HTML marked 18.1.3 produces with default options (GFM on, breaks off), byte for byte — but faster. A single hand-written ES module (`parse.js`) with its own block/inline lexer and renderer: no dependencies, no caching across cases, deterministic output. `main.ts` is the driver the harness runs: it reads every case from `cases.json`, renders each one alone with `parse()`, and writes the HTML strings to `html.json` in case order.

The grammar regular expressions in `parse.js` follow marked 18.1.3 (MIT, Copyright (c) 2018+ MarkedJS, Copyright (c) 2011-2018 Christopher Jeffrey — see LICENSE); the lexer, parser and renderer are original.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=gmn2mnxf&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
