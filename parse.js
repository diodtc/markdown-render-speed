// Fast CommonMark + GFM renderer, byte-compatible with marked 18.1.3
// (default options: gfm on, breaks off, pedantic off, async off).
//
// The grammar regexes below follow marked 18.1.3 (MIT, Copyright (c) 2018+
// MarkedJS and Copyright (c) 2011-2018 Christopher Jeffrey); the block
// scanner, inline renderer and all of the logic around them are my own work,
// written for speed: index-based scanning (no substring copying), direct
// rendering without a token tree, and first-character dispatch in the
// inline loop. See LICENSE for the full MIT texts.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// ---------------------------------------------------------------- helpers

function escapeHtml(html, encode) {
  if (encode) {
    if (/[&<>"']/.test(html)) return html.replace(/[&<>"']/g, (ch) => ESC[ch]);
  } else {
    if (/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(html)) {
      return html.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ch) => ESC[ch]);
    }
  }
  return html;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Numeric character references stand for the character they name outside
// code; zero, out of range and surrogate values become U+FFFD. A bare `&`
// that cannot start a reference is escaped here so a decoded character
// cannot join its neighbours into a new reference.
function decodeNumericRefs(text) {
  if (!NUM_REF.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a table row on unescaped pipes; a pipe preceded by an odd number
// of backslashes is escaped and kept.
function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Remove trailing `c`s (or, with invert, trailing non-`c`s). Equivalent to
// str.replace(/c*$/, '') without the catastrophic backtracking.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const curr = str.charAt(l - suffLen - 1);
    if (curr === c && !invert) suffLen++;
    else if (curr !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

const BLANK_LINE = /^[ \t]*$/;
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && BLANK_LINE.test(lines[end])) end--;
  if (lines.length - end <= 2) return str; // keep single trailing blank lines
  return lines.slice(0, end + 1).join('\n');
}

// Link labels match after Unicode case folding (round-tripping through
// upper case folds ß/ẞ together) with whitespace runs collapsed.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes the level opened inside `str`, or -1
// when there is none and -2 when more are opened than closed.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// One scan of an inline source for the last `*`, `_` and `~` runs that can
// close emphasis/strong/strikethrough: a run can close only when it is not
// preceded by ASCII whitespace or the start of the string. Returns
// [star, underscore, tilde] indexes, -1 when there is none.
function scanClosers(src) {
  let star = -1, und = -1, tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else und = i;
    }
    i = j - 1;
  }
  return [star, und, tilde];
}

// ------------------------------------------------------------------ grammar
// Compose a regex from a pattern by splicing in named sub-patterns, the
// way marked's `edit` does: a `^` at the head of a spliced value is
// dropped so it cannot anchor in the middle of the result.
function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const supportsLookbehind = ((a = '') => {
  try { return !!new RegExp('(?<=1)(?<!1)' + a); } catch { return false; }
})();

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  // Neutralize a lazy setext underline, including one with trailing tabs.
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  caret: /(^|[^\[])\^/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  // a list item ends where a paragraph would be interrupted, so this mirrors
  // the html start conditions in the paragraph rule; type 7 is excluded there
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// ---- block grammar (GFM) ----

const blockNewline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const blockFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const blockHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const blockHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
// The underline may end with spaces or tabs (CommonMark §4.3). Internal
// spaces or tabs still fail to match, and more than three spaces of indent
// still do not.
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingGfm = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const blockDef = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  // An escaped delimiter is part of the title, so a backslash must consume
  // the next character. An optional closer lets that character backtrack
  // into the closing quote.
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const blockList = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const blockHtml = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open tag
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const createParagraph = (listInterrupt) => edit(_paragraph)
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '') // setext headings don't interrupt commonmark paragraphs
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', listInterrupt)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag) // pars can be interrupted by html blocks of types (1) to (6)
  .getRegex();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n' // Header
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' // Align
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)') // Cells
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]') // any bullet ends the table rows
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag) // tables can be interrupted by html blocks of types (1) to (6)
  .getRegex();

// only non-empty lists starting from 1 can interrupt paragraphs
const gfmParagraph = edit(_paragraph)
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '') // setext headings don't interrupt commonmark paragraphs
  .replace('table', gfmTable) // interrupt paragraphs with table
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]') // only non-empty lists starting from 1 can interrupt
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag) // pars can be interrupted by html blocks of types (1) to (6)
  .getRegex();

// inside a blockquote a bare list marker (any number) starts a sibling list,
// so it must not be lazily continued as paragraph text (unlike a top level
// paragraph, where an empty list cannot interrupt)
const blockquoteParagraph = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

// a line with only whitespace after the marker is blank, so it must not start
// a paragraph that lazily continues onto the next line
const blockBlockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).
  replace('paragraph', blockquoteParagraph)
  .getRegex();

// ---- inline grammar (GFM) ----

const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const inlineTextGfm = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  // GFM: a www autolink starts only at the beginning of a line, after
  // whitespace or after `*`, `_`, `~` or `(`. Without lookbehind support,
  // keep stopping at every `www.`.
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

// list of unicode punctuation marks, plus any missing characters from CommonMark spec
const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();

// GFM allows ~ inside strong and em for strikethrough
const _punctGfm = /(?!~)[\p{P}\p{S}]/u;
const _punctOrSpaceGfm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctOrSpaceGfm = /(?:[^\s\p{P}\p{S}]|~)/u;

// sequences em should skip over [title](link), `code`, <html>
const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimGfm = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctGfm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const emStrongRDelimAstGfm = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctOrSpaceGfm)
  .replace(/punctSpace/g, _punctOrSpaceGfm)
  .replace(/punct/g, _punctGfm)
  .getRegex();

// Normal: no rule 6 for _ (a___a cannot close as emphasis).
const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

// Tilde left delimiter for strikethrough (similar to emStrongLDelim for asterisk)
const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

// Tilde delimiter patterns for strikethrough (similar to asterisk)
const delRDelimCore =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

// `anyPunctuation` for the em/strong mask. A backslash is literal inside a
// code span, so a code span (matched like `inline.code`), or a backtick run
// that opens none, is matched whole and kept; only the escapes outside code
// spans are masked.
const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const inlineAutolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const inlineTag = edit(
  '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
    + '|^<\\?[\\s\\S]*?\\?>' // processing instruction, e.g. <?php ?>
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration, e.g. <!DOCTYPE html>
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

// One matched pair of brackets, holding no bracket of its own.
const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// CommonMark lets the brackets in a link label nest to any depth, which a
// regex cannot follow, so it stops at a fixed one. Two levels is what the
// spec suite asks for: a third and a fourth flip no further example.
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const inlineLink = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  // Same as the definition title: the escaped character is not the closer.
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const inlineReflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const inlineNolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

// `reflink` and `nolink` are anchored, so the tokenizer tries each of them
// at a single position. `reflinkSearch` drops the anchors and runs with the
// global flag, which makes every '[' in the source a start position. The
// labels below bound that scan: `_boundedInlineLabel` limits how many
// escapes, code spans and nested brackets a link text may hold, and
// `_boundedBlockLabel` limits the label itself to 999 items, which is every
// label CommonMark allows.
const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();

const inlineUrl = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const inlineBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const inlineDel = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Sticky copies of the anchored regexes, for matching at a position inside
// a longer string without copying the remainder. The sticky flag already
// anchors the match at lastIndex, so every `^` anchor is dropped — a `^`
// in a non-multiline regex means "position 0 of the whole string", which
// would make the pattern unmatchable anywhere past the first byte. A `^`
// inside a character class (negation, or a literal) is kept.
function stripAnchors(src) {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      out += c;
      if (i + 1 < src.length) out += src[++i];
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    if (c === '^' && !inClass) continue;
    out += c;
  }
  return out;
}
function sticky(re) {
  return new RegExp(stripAnchors(re.source), re.flags.includes('y') ? re.flags : re.flags + 'y');
}
const S = {
  newline: sticky(blockNewline),
  code: sticky(blockCode),
  fences: sticky(blockFences),
  hr: sticky(blockHr),
  heading: sticky(blockHeading),
  lheading: sticky(lheadingGfm),
  def: sticky(blockDef),
  list: sticky(blockList),
  html: sticky(blockHtml),
  blockquote: sticky(blockBlockquote),
  table: sticky(gfmTable),
  paragraph: sticky(gfmParagraph),
  text: sticky(blockText),
  escape: sticky(inlineEscape),
  tag: sticky(inlineTag),
  link: sticky(inlineLink),
  reflink: sticky(inlineReflink),
  nolink: sticky(inlineNolink),
  codeSpan: sticky(inlineCode),
  br: sticky(inlineBr),
  autolink: sticky(inlineAutolink),
  url: sticky(inlineUrl),
  del: sticky(inlineDel),
  delLDelim: sticky(delLDelim),
  emStrongLDelim: sticky(emStrongLDelimGfm),
  textRun: sticky(inlineTextGfm),
};

// ------------------------------------------------------------ block scanner
// A parse keeps one context: the link definitions found anywhere in the
// document, the `top` flag (paragraphs only exist at the top level), and
// the inline runs in scan order (the checkbox pass reads them back).
function newCtx() {
  return {
    links: new Map(),
    top: true,
    inlineRuns: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
}

// A block is a small descriptor; `text` fields hold the string the inline
// renderer reads. `adv` is how far the scanner advances past the block.
// `rawEndsNL` tracks whether a paragraph/text block's raw ended with a
// newline (the merge logic reads it); blockquote/list keep their `raw`
// string because the continuation logic reads it back.

function indentCodeCompensation(raw, text) {
  const m = raw.match(other.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(other.beginningSpace);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function tokSpace(str, pos) {
  S.newline.lastIndex = pos;
  const m = S.newline.exec(str);
  return (m && m[0].length > 0) ? m[0].length : 0;
}

function tokCode(str, pos) {
  S.code.lastIndex = pos;
  const m = S.code.exec(str);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { d: { t: 'code', text: raw.replace(other.codeRemoveIndent, ''), lang: undefined }, adv: raw.length, raw };
}

function tokFences(str, pos) {
  S.fences.lastIndex = pos;
  const m = S.fences.exec(str);
  if (!m) return null;
  const raw = m[0];
  const text = indentCodeCompensation(raw, m[3] || '');
  return { d: { t: 'code', text, lang: m[2] ? m[2].trim().replace(anyPunctuation, '$1') : m[2] }, adv: raw.length };
}

function tokHeading(str, pos) {
  S.heading.lastIndex = pos;
  const m = S.heading.exec(str);
  if (!m) return null;
  let text = m[2].trim();
  if (other.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
      // CommonMark requires a space or tab before trailing #s
      text = trimmed.trim();
    }
  }
  const d = { t: 'heading', depth: m[1].length, text };
  return { d, adv: rtrim(m[0], '\n').length };
}

function tokHr(str, pos) {
  S.hr.lastIndex = pos;
  const m = S.hr.exec(str);
  if (!m) return null;
  return { d: { t: 'hr' }, adv: rtrim(m[0], '\n').length };
}

function tokHtml(str, pos) {
  S.html.lastIndex = pos;
  const m = S.html.exec(str);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { d: { t: 'html', text: raw }, adv: raw.length };
}

function tokDef(str, pos) {
  S.def.lastIndex = pos;
  const m = S.def.exec(str);
  if (!m) return null;
  // outside angle brackets a link destination holds only balanced parentheses
  if (!other.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(anyPunctuation, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(anyPunctuation, '$1') : m[3];
  const raw = rtrim(m[0], '\n');
  return { d: { t: 'def' }, adv: raw.length, raw, tag, href, title };
}

function tokTable(str, pos, ctx) {
  S.table.lastIndex = pos;
  const m = S.table.exec(str);
  if (!m) return null;
  if (!other.tableDelimiter.test(m[2])) {
    // delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading
    return null;
  }
  const headers = splitCells(m[1]);
  const aligns = m[2].replace(other.tableAlignChars, '').split('|');
  const rows = m[3]?.trim() ? m[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) {
    // header and align columns must be equal, rows can be different.
    return null;
  }
  const align = [];
  for (const a of aligns) {
    if (other.tableAlignRight.test(a)) align.push('right');
    else if (other.tableAlignCenter.test(a)) align.push('center');
    else if (other.tableAlignLeft.test(a)) align.push('left');
    else align.push(null);
  }
  const header = [];
  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], align: align[i], header: true };
    header.push(cell);
    ctx.inlineRuns.push(cell);
  }
  const outRows = [];
  for (const row of rows) {
    outRows.push(splitCells(row, headers.length).map((cell, i) => {
      const c = { text: cell, align: align[i], header: false };
      ctx.inlineRuns.push(c);
      return c;
    }));
  }
  return { d: { t: 'table', header, align, rows: outRows }, adv: rtrim(m[0], '\n').length };
}

function tokLheading(str, pos) {
  S.lheading.lastIndex = pos;
  const m = S.lheading.exec(str);
  if (!m) return null;
  const d = { t: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() };
  return { d, adv: rtrim(m[0], '\n').length };
}

function tokParagraph(str, pos) {
  S.paragraph.lastIndex = pos;
  const m = S.paragraph.exec(str);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { d: { t: 'paragraph', text, rawEndsNL: false }, adv: m[0].length };
}

function tokText(str, pos) {
  S.text.lastIndex = pos;
  const m = S.text.exec(str);
  if (!m) return null;
  return { d: { t: 'text', text: m[0], rawEndsNL: false }, adv: m[0].length };
}

// A line that is only a setext underline, used for the lazy-continuation
// check inside list items.
const setextLineTest = /^ {0,3}(?:=+|-+) *$/;

function tokBlockquote(str, pos, ctx) {
  S.blockquote.lastIndex = pos;
  const cap = S.blockquote.exec(str);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      // get lines up to a continuation
      if (other.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // a tab after the block quote marker runs to the next tab stop, and
      // the marker only consumes one space of it; the rest is content
      .replace(
        other.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      // precede setext continuation with 4 spaces so it isn't a setext
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // parse blockquote lines as top level tokens
    // merge paragraphs if this is a continuation
    const top = ctx.top;
    ctx.top = true;
    scanBlocks(ctx, currentText, tokens, true);
    ctx.top = top;

    // if there is no continuation then we are done
    if (lines.length === 0) break;

    const lastToken = tokens[tokens.length - 1];

    if (lastToken?.t === 'code' || lastToken?.t === 'heading' || lastToken?.t === 'hr' || lastToken?.t === 'html' || lastToken?.t === 'table') {
      // blockquote continuation cannot be preceded by a code block, heading, hr, html block or table
      break;
    } else if (lastToken?.t === 'blockquote') {
      // include continuation in nested blockquote
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the
      // nested blockquote, which already had one '>' marker stripped, so
      // strip one marker from them too.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const nt = tokBlockquote(newText, 0, ctx);
      if (!nt) break;
      const newToken = nt.d;
      tokens[tokens.length - 1] = newToken;

      // Only include continuation lines the nested blockquote actually
      // consumed. Unconsumed trailing lines must stay out of `raw` so the
      // lexer can still tokenize them.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) {
        raw = `${raw}\n${consumed.join('\n')}`;
      }
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      // A leftover line that starts with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
        continue;
      }
      break;
    } else if (lastToken?.t === 'list') {
      // include continuation in nested list
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const nt = tokList(newText, 0, ctx);
      if (!nt) break;
      const newToken = nt.d;
      tokens[tokens.length - 1] = newToken;

      // The list raw has no '>' markers, so it cannot be cut out of `raw`.
      // Count the continuation lines the list took and add those lines instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { d: { t: 'blockquote', children: tokens, raw, text }, adv: raw.length };
}

function lineAt(str, p) {
  const nl = str.indexOf('\n', p);
  return nl === -1 ? str.slice(p) : str.slice(p, nl);
}

function tokList(str, pos, ctx) {
  S.list.lastIndex = pos;
  let cap = S.list.exec(str);
  if (!cap) return null;
  const len = str.length;
  let p = pos;
  const taken = () => p - pos;

  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  // Get next list item
  const itemRegex = sticky(other.listItemRegex(bull));
  let endsWithBlankLine = false;
  // Check if current bullet point can start a new List Item
  while (p < len) {
    let endEarly = false;
    let itemContents = '';
    itemRegex.lastIndex = p;
    if (!(cap = itemRegex.exec(str))) break;

    S.hr.lastIndex = p;
    if (S.hr.exec(str)) break; // End list if bullet was actually HR

    const itemStart = p;
    p += cap[0].length;

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = lineAt(str, p);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar); // Find first non-space char
      indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && other.blankLine.test(nextLine)) { // Items begin with at most one blank line
      p = Math.min(p + nextLine.length + 1, len);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRegex = other.nextBulletRegex(indent);
      const hrRegex = other.hrRegex(indent);
      const fencesBeginRegex = other.fencesBeginRegex(indent);
      const headingBeginRegex = other.headingBeginRegex(indent);
      const htmlBeginRegex = other.htmlBeginRegex(indent);
      const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);

      // Check if following lines should be included in List Item
      while (p < len) {
        const rawLine = lineAt(str, p);
        let nextLineWithoutTabs;
        nextLine = rawLine;
        nextLineWithoutTabs = nextLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws));

        // End list item if found code fences
        if (fencesBeginRegex.test(nextLine)) break;
        // End list item if found start of new heading
        if (headingBeginRegex.test(nextLine)) break;
        // End list item if found start of html block
        if (htmlBeginRegex.test(nextLine)) break;
        // End list item if found start of blockquote
        if (blockquoteBeginRegex.test(nextLine)) break;
        // End list item if found start of new bullet
        if (nextBulletRegex.test(nextLine)) break;
        // Horizontal rule found
        if (hrRegex.test(nextLine)) break;

        if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) { // Dedent if possible
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // not enough indentation
          if (blankLine) break;
          // paragraph continuation unless last line was a different block level element
          if (line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4) break; // indented code block
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;

          // A lazy continuation can look like a setext underline after
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = setextLineTest.test(nextLine)
            && lheadingGfm.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        p = Math.min(p + rawLine.length + 1, len);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    // The loops above appended a '\n' the source may not have had. It could
    // only land on the item that exhausts src, whose raw is trimmed below.
    const raw = str.slice(itemStart, p);

    if (!list.loose) {
      // If the previous item ended with a blank line, the list is loose
      if (endsWithBlankLine) list.loose = true;
      else if (other.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      t: 'list_item',
      raw,
      task: other.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  // Do not consume newlines at end of final item.
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    // not a list since there were no items
    return null;
  }
  list.raw = str.slice(pos, p).trimEnd();

  // Item child tokens handled here at end because we needed to have the final item to trim it first
  // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = scanBlocks(ctx, item.text, [], false);

    if (!list.loose) {
      // Check if list should be loose
      const spacers = item.tokens.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => t.blank);
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.t === 'text' || itemToken?.t === 'paragraph')) {
      // The checkbox's inline run lives in the global queue; find the last
      // entry that still starts with a checkbox and strip it there. This
      // runs before the item token itself is stripped, so the search still
      // sees the checkbox.
      for (let i = ctx.inlineRuns.length - 1; i >= 0; i--) {
        if (other.listIsTask.test(ctx.inlineRuns[i].text)) {
          ctx.inlineRuns[i].text = ctx.inlineRuns[i].text.replace(other.listReplaceTask, '');
          break;
        }
      }
      // Remove checkbox markdown from item tokens
      item.text = item.text.replace(other.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(other.listReplaceTask, '');

      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        item.checked = checked;
        if (list.loose) {
          // checkbox goes inside the first paragraph's inline output
          itemToken.cbHtml = checkboxHtml;
        } else {
          // checkbox is a block-level token at the head of the item
          item.cbHtml = checkboxHtml;
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // Set all items to loose if list is loose
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') token.t = 'paragraph';
      }
    }
  }

  return { d: list, adv: list.raw.length };
}

// The block loop, in marked's trial order, with a first-character dispatch
// so a line only runs the regexes that can match it. `pos` is an index into
// `str` (no substring copying); each tokenizer reports how far to advance.
function scanBlocks(ctx, str, out, lastParagraphClipped = false) {
  const len = str.length;
  let pos = 0;
  let srcLength = Infinity;
  while (pos < len) {
    const rem = len - pos;
    if (rem < srcLength) srcLength = rem;
    else throw new Error('Infinite loop on byte: ' + str.charCodeAt(pos));

    let sp = 0;
    while (str[pos + sp] === ' ') sp++;
    const afterSpaces = str[pos + sp];
    const codeIndent = sp >= 4 || (afterSpaces === '\t' && sp <= 3);
    // blank line? scan past spaces/tabs to the line end
    let j = pos;
    while (j < len && (str[j] === ' ' || str[j] === '\t')) j++;
    const blank = j >= len || str[j] === '\n';
    const c1 = blank ? '' : str[j];

    // newline
    if (blank) {
      const sAdv = tokSpace(str, pos);
      if (sAdv > 0) {
        if (sAdv === 1 && out.length > 0) {
          // if there's a single \n as a spacer, it's terminating the last
          // line, so move it there so we don't get unnecessary paragraph tags
          const last = out[out.length - 1];
          if (last.raw !== undefined) last.raw += '\n';
          else if (last.t === 'paragraph' || last.t === 'text') last.rawEndsNL = true;
          pos += 1;
          continue;
        }
        let nls = 0;
        for (let k = pos; k < pos + sAdv; k++) if (str[k] === '\n') nls++;
        out.push({ t: 'space', blank: nls >= 2 });
        pos += sAdv;
        continue;
      }
    }

    // code (indented)
    if (codeIndent) {
      const r = tokCode(str, pos);
      if (r) {
        pos += r.adv;
        const last = out[out.length - 1];
        // An indented code block cannot interrupt a paragraph.
        if (last && (last.t === 'paragraph' || last.t === 'text')) {
          last.text += '\n' + r.d.text;
          last.rawEndsNL = r.raw.endsWith('\n');
        } else {
          out.push(r.d);
        }
        continue;
      }
    }

    // fences
    if (c1 === '`' || c1 === '~') {
      const r = tokFences(str, pos);
      if (r) { pos += r.adv; out.push(r.d); continue; }
    }

    // heading
    if (c1 === '#') {
      const r = tokHeading(str, pos);
      if (r) { pos += r.adv; out.push(r.d); ctx.inlineRuns.push(r.d); continue; }
    }

    // hr
    if (c1 === '-' || c1 === '_' || c1 === '*') {
      const r = tokHr(str, pos);
      if (r) { pos += r.adv; out.push(r.d); continue; }
    }

    // blockquote
    if (c1 === '>') {
      const r = tokBlockquote(str, pos, ctx);
      if (r) { pos += r.adv; out.push(r.d); continue; }
    }

    // list
    if (c1 === '*' || c1 === '+' || c1 === '-' || (c1 >= '0' && c1 <= '9')) {
      const r = tokList(str, pos, ctx);
      if (r) { pos += r.adv; out.push(r.d); continue; }
    }

    // html
    if (c1 === '<') {
      const r = tokHtml(str, pos);
      if (r) { pos += r.adv; out.push(r.d); continue; }
    }

    // def
    if (c1 === '[') {
      const r = tokDef(str, pos);
      if (r) {
        pos += r.adv;
        const last = out[out.length - 1];
        if (last && (last.t === 'paragraph' || last.t === 'text')) {
          last.text += '\n' + r.raw;
          last.rawEndsNL = r.raw.endsWith('\n');
        } else {
          // The first definition of a label wins, but a later one still consumes its text
          if (!ctx.links.has(r.tag)) ctx.links.set(r.tag, { href: r.href, title: r.title });
          out.push(r.d);
        }
        continue;
      }
    }

    // table (gfm)
    {
      const r = tokTable(str, pos, ctx);
      if (r) { pos += r.adv; out.push(r.d); continue; }
    }

    // lheading
    {
      const r = tokLheading(str, pos);
      if (r) { pos += r.adv; out.push(r.d); ctx.inlineRuns.push(r.d); continue; }
    }

    // top-level paragraph
    if (ctx.top) {
      const r = tokParagraph(str, pos);
      if (r) {
        pos += r.adv;
        const last = out[out.length - 1];
        if (lastParagraphClipped && last && last.t === 'paragraph') {
          last.text += '\n' + r.d.text;
          last.rawEndsNL = false;
        } else {
          out.push(r.d);
          ctx.inlineRuns.push(r.d);
        }
        lastParagraphClipped = false;
        continue;
      }
    }

    // text
    {
      const r = tokText(str, pos);
      if (r) {
        pos += r.adv;
        const last = out[out.length - 1];
        if (last && last.t === 'text') {
          last.text += '\n' + r.d.text;
          last.rawEndsNL = false;
        } else {
          out.push(r.d);
          ctx.inlineRuns.push(r.d);
        }
        continue;
      }
    }

    throw new Error('Infinite loop on byte: ' + str.charCodeAt(pos));
  }

  ctx.top = true;
  return out;
}

// ---------------------------------------------------------- inline rendering
// An inline run is rendered straight to its HTML (or, in text mode, to the
// plain text the image alt attribute and the text renderer need). `mode` is
// 'html' or 'text'. The run's state lives on `ctx` so a link label nested
// inside another run sees the same inLink/inRawBlock/linkEmitted, and
// `linkParenPossible` is saved and restored around every run.

function linkHtml(href, title, parsedText) {
  const clean = cleanUrl(href);
  if (clean === null) return parsedText;
  let out = '<a href="' + escapeHtml(clean) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}

function autolinkHtml(href, text) {
  const clean = cleanUrl(href);
  if (clean === null) return escapeHtml(text, true);
  return '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(text, true) + '</a>';
}

function imageHtml(href, title, altText) {
  const clean = cleanUrl(href);
  if (clean === null) return escapeHtml(altText);
  let out = `<img src="${escapeHtml(clean)}" alt="${escapeHtml(altText)}"`;
  if (title) out += ` title="${escapeHtml(title)}"`;
  out += '>';
  return out;
}

// Does this link text hold a link already? An image does not count: an image
// may hold a link, a link may not.
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(blockSkip)) {
    if (inlineLink.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !ctx.links.has(normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    // a candidate holding a link is not a link either, so it does not count
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them. Every mask keeps the length it replaces: emStrong
// and del line the masked source up with the real one by slicing from the end.
function maskSrc(ctx, src) {
  let masked = src;

  // Mask out reflinks
  if (ctx.links.size > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!ctx.links.has(normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // CommonMark: "Links may not contain other links, at any level of
      // nesting." A candidate whose text already holds one never becomes a
      // link, so flattening the whole span would hide the emphasis that
      // does still apply inside it. Mask the links it holds instead.
      // Images are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(reflinkSearch, maskReflink);
  }

  // Mask out escaped characters.
  // A backslash inside a code span is literal, not an escape. Mask the
  // backticks inside the span instead, so blockSkip still skips all of it.
  masked = masked.replace(anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });

  // Mask out other blocks
  masked = masked.replace(blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });

  return masked;
}

// Is the `]` that ends this label inside an HTML tag or autolink that
// started inside the label? Then the label does not end there.
function isLabelEndInsideToken(str, pos, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCode.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = str.slice(pos + labelStart + i);
    const token = inlineTag.exec(tokenSrc) || inlineAutolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function tokEscape(str, pos, mode) {
  S.escape.lastIndex = pos;
  const cap = S.escape.exec(str);
  if (!cap) return null;
  return { out: mode === 'html' ? escapeHtml(cap[1]) : cap[1], adv: cap[0].length };
}

function tokTag(str, pos, ctx, mode) {
  S.tag.lastIndex = pos;
  const cap = S.tag.exec(str);
  if (!cap) return null;
  if (!ctx.inLink && other.startATag.test(cap[0])) ctx.inLink = true;
  else if (ctx.inLink && other.endATag.test(cap[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && other.startPreScriptTag.test(cap[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && other.endPreScriptTag.test(cap[0])) ctx.inRawBlock = false;
  return { out: cap[0], adv: cap[0].length };
}

function tokAutolink(str, pos, mode) {
  S.autolink.lastIndex = pos;
  const cap = S.autolink.exec(str);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { out: mode === 'html' ? autolinkHtml(href, text) : text, adv: cap[0].length };
}

function tokCodespan(str, pos, mode) {
  S.codeSpan.lastIndex = pos;
  const cap = S.codeSpan.exec(str);
  if (!cap) return null;
  let text = cap[2].replace(other.newLineCharGlobal, ' ');
  const hasNonSpaceChars = other.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { out: mode === 'html' ? `<code>${escapeHtml(text, true)}</code>` : text, adv: cap[0].length };
}

function tokBr(str, pos, mode) {
  S.br.lastIndex = pos;
  const cap = S.br.exec(str);
  if (!cap) return null;
  return { out: mode === 'html' ? '<br>' : '', adv: cap[0].length };
}

function tokInlineText(str, pos, ctx, mode) {
  S.textRun.lastIndex = pos;
  const cap = S.textRun.exec(str);
  if (!cap) return null;
  const escaped = ctx.inRawBlock;
  // raw HTML keeps whatever it was written with, everywhere else a numeric
  // character reference stands for the character itself
  const text = escaped ? cap[0] : decodeNumericRefs(cap[0]);
  return { raw: cap[0], out: mode === 'html' ? (escaped ? text : escapeHtml(text)) : text, adv: cap[0].length };
}

// Last code point of the slice ending at `end` (an astral character counts
// as one). Used for the character before an emphasis run.
function lastCodePoint(str, end) {
  if (end <= 0) return '';
  const lo = str.charCodeAt(end - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
    const hi = str.charCodeAt(end - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return str.slice(end - 2, end);
  }
  return str[end - 1];
}

function tokEmStrong(str, pos, ctx, pass, mode, prevChar) {
  S.emStrongLDelim.lastIndex = pos;
  let match = S.emStrongLDelim.exec(str);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`)
  // must only pair with a delimiter that can only close, otherwise it
  // steals the opener of a later span.
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind pos, either taken
  // as text after the whole run failed to match or used to close an earlier
  // span. Flanking and rules 9-10 are about the whole run, so find its start.
  const maskedSrc = pass.masked;
  let runStart = pos;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = lastCodePoint(maskedSrc, runStart);
  // The other delimiter character counts as punctuation here (`_**a*`)
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuation.exec(runPrevChar);
  if (runStart < pos) prevChar = runPrevChar;
  const prevPunct = runStart < pos ? runPrevPunct : !!punctuation.exec(prevChar);

  // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
  if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return null;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // unicode Regex counts emoji as 1 char; spread into array for proper count
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well (`a*b**`, where `*` is both left- and right-flanking).
    const runLength = pos - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? emStrongRDelimAstGfm : emStrongRDelimUnd;
    const lastPossible = delimChar === '*' ? pass.scan[0] : pass.scan[1];
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    // Clip maskedSrc to same section of string as src
    const win = maskedSrc.slice(windowStart);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(win)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__

      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either Left or Right Delim
        if (midRun && (match[5] || match[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter
          // that can also open; that delimiter opens its own emphasis span.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters. *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      // char length can be >1 for unicode characters;
      const lastCharLength = [...match[0]][0].length;
      const raw = str.slice(pos, pos + lLength + match.index + lastCharLength + rLength);

      // Create `em` if smallest delimiter has odd char count. *a***
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const nested = renderInline(ctx, text, mode, false);
        return { out: mode === 'html' ? `<em>${nested}</em>` : nested, adv: raw.length };
      }

      // Create 'strong' if smallest delimiter has even char count. **a***
      const text = raw.slice(2, -2);
      const nested = renderInline(ctx, text, mode, false);
      return { out: mode === 'html' ? `<strong>${nested}</strong>` : nested, adv: raw.length };
    }
  }
  return null;
}

function tokDel(str, pos, ctx, pass, mode, prevChar) {
  S.delLDelim.lastIndex = pos;
  let match = S.delLDelim.exec(str);
  if (!match) return null;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || punctuation.exec(prevChar)) {
    // unicode Regex counts emoji as 1 char; spread into array for proper count
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = delRDelim;
    const lastPossible = pass.scan[2];
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    // Clip maskedSrc to same section of string as src
    const win = pass.masked.slice(windowStart);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(win)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;

      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;

      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters
      rLength = Math.min(rLength, rLength + delimTotal);
      // char length can be >1 for unicode characters
      const lastCharLength = [...match[0]][0].length;
      const raw = str.slice(pos, pos + lLength + match.index + lastCharLength + rLength);

      // Create del token - only single ~ or double ~~ supported
      const text = raw.slice(lLength, -lLength);
      const nested = renderInline(ctx, text, mode, false);
      return { out: mode === 'html' ? `<del>${nested}</del>` : nested, adv: raw.length };
    }
  }
  return null;
}

function outputLink(ctx, cap, link, raw, mode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;

  if (!isImage) {
    const nested = renderInline(ctx, text, mode, false);
    const textHasLink = ctx.linkEmitted;
    ctx.linkEmitted = outerLinkEmitted;
    ctx.inLink = outerInLink;
    // CommonMark: "Links may not contain other links, at any level of
    // nesting." Bail so the caller falls through to text and the inner link
    // is the one kept.
    if (textHasLink) {
      // these tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text that is re-scanned
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
    return { out: mode === 'html' ? linkHtml(href, title, nested) : nested, adv: raw.length };
  }

  // Images are exempt: their text is flattened into an alt attribute, which
  // is rendered as plain text.
  const alt = renderInline(ctx, text, 'text', false);
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  return { out: mode === 'html' ? imageHtml(href, title, alt) : alt, adv: raw.length };
}

function tokLink(str, pos, ctx, mode) {
  // The link regex backtracks quadratically over unterminated-link inputs
  // like '[a](b'.repeat(n). One paren scan per run is anchored in
  // renderInline; when it is false the regex cannot match, so bail out
  // before running it.
  if (ctx.linkParenPossible === false) return null;
  S.link.lastIndex = pos;
  const cap = S.link.exec(str);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(str, pos, cap[1], labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (other.startAngleBracket.test(trimmedUrl)) {
    // commonmark requires matching angle brackets
    if (!(other.endAngleBracket.test(trimmedUrl))) return null;
    // ending angle bracket cannot be escaped
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    // find closing parenthesis
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null; // more open parens than closed
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped. `[foo](/url\)` has no closer; that paren is destination text.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(ctx, cap, {
    href: href ? href.replace(anyPunctuation, '$1') : href,
    title: title ? title.replace(anyPunctuation, '$1') : title,
  }, cap[0], mode);
}

function tokReflink(str, pos, ctx, mode) {
  let cap;
  S.reflink.lastIndex = pos;
  cap = S.reflink.exec(str);
  if (!cap) {
    S.nolink.lastIndex = pos;
    cap = S.nolink.exec(str);
  }
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(str, pos, cap[1], labelStart)) return null;

  const link = ctx.links.get(normalizeLabel(cap[2] || cap[1]));
  if (!link) {
    const ch = cap[0].charAt(0);
    return { textChar: ch, adv: 1 };
  }
  return outputLink(ctx, cap, link, cap[0], mode);
}

// Could an extended autolink start here? The url regex itself is the
// authority; this only skips running it where it cannot match.
function maybeUrl(str, pos) {
  const ch = str[pos];
  if (ch === 'w' && str.startsWith('www.', pos)) return true;
  if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(str.slice(pos, pos + 8))) return true;
  if ((ch === 'f' || ch === 'F') && str.slice(pos, pos + 6).toLowerCase() === 'ftp://') return true;
  if (ch === 'm' && str.startsWith('mailto:', pos)) return true;
  if (ch === 'x' && str.startsWith('xmpp:', pos)) return true;
  // an email address: a run of address characters followed by '@' and a domain start
  let i = pos;
  while (i < str.length) {
    const c = str[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
      || c === '.' || c === '_' || c === '+' || c === '-' || c === '!' || c === '#'
      || c === '$' || c === '%' || c === '&' || c === "'" || c === '*' || c === '/'
      || c === '=' || c === '?' || c === '^' || c === '`' || c === '{' || c === '|'
      || c === '}' || c === '~') i++;
    else break;
  }
  if (i > pos && str[i] === '@' && i + 1 < str.length) {
    const d = str[i + 1];
    if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9')) return true;
  }
  return false;
}

function tokUrl(str, pos, ctx, mode) {
  S.url.lastIndex = pos;
  const cap = S.url.exec(str);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    // do extended autolink path validation
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = inlineBackpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { out: mode === 'html' ? autolinkHtml(href, text) : text, adv: cap[0].length };
}

// Render one inline run. `topLevel` resets the raw-block flag the way the
// block lexer does before each queued run; nested runs inherit it.
function renderInline(ctx, str, mode, topLevel) {
  if (topLevel) ctx.inRawBlock = false;
  // One paren scan per inline run, shared with tokLink: without a ')'
  // ahead the link regex cannot match. A nested run receives a substring
  // of the outer run, so if the outer had no ')' neither does this one.
  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = (topLevel ? true : prevLinkParenPossible) && str.includes(')');
  try {
    return renderInlineInner(ctx, str, mode);
  } finally {
    ctx.linkParenPossible = prevLinkParenPossible;
  }
}

function renderInlineInner(ctx, str, mode) {
  // The masked source is only read by emStrong and del, which need a *, _
  // or ~ to start. Skip building it for a run without one.
  const masked = (str.includes('*') || str.includes('_') || str.includes('~'))
    ? maskSrc(ctx, str)
    : str;
  const pass = { src: str, masked, scan: scanClosers(masked) };

  const out = [];
  const len = str.length;
  let pos = 0;
  let prevChar = '';
  let keepPrevChar = false;
  let srcLength = Infinity;
  while (pos < len) {
    const rem = len - pos;
    if (rem < srcLength) srcLength = rem;
    else throw new Error('Infinite loop on byte: ' + str.charCodeAt(pos));

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    const ch = str[pos];
    let r = null;

    if (ch === '\\') {
      r = tokEscape(str, pos, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
      r = tokBr(str, pos, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    } else if (ch === '<') {
      r = tokTag(str, pos, ctx, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
      r = tokAutolink(str, pos, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    } else if (ch === '[' || ch === '!') {
      r = tokLink(str, pos, ctx, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
      r = tokReflink(str, pos, ctx, mode);
      if (r) {
        if (r.textChar !== undefined) {
          // an unmatched reference degrades to its first character as text
          out.push(mode === 'html' ? escapeHtml(r.textChar) : r.textChar);
          if (r.textChar !== '_') prevChar = r.textChar;
          keepPrevChar = true;
          pos += 1;
          continue;
        }
        out.push(r.out); pos += r.adv; continue;
      }
    } else if (ch === '*' || ch === '_') {
      r = tokEmStrong(str, pos, ctx, pass, mode, prevChar);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    } else if (ch === '`') {
      r = tokCodespan(str, pos, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    } else if (ch === '~') {
      r = tokDel(str, pos, ctx, pass, mode, prevChar);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    } else if (ch === ' ') {
      r = tokBr(str, pos, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    }

    // url (gfm): only outside a link
    if (!ctx.inLink && maybeUrl(str, pos)) {
      r = tokUrl(str, pos, ctx, mode);
      if (r) { out.push(r.out); pos += r.adv; continue; }
    }

    // text
    r = tokInlineText(str, pos, ctx, mode);
    if (r) {
      if (r.raw.slice(-1) !== '_') prevChar = r.raw.slice(-1); // Track prevChar before string of ____ started
      keepPrevChar = true;
      out.push(r.out);
      pos += r.adv;
      continue;
    }

    throw new Error('Infinite loop on byte: ' + str.charCodeAt(pos));
  }
  return out.join('');
}

// ----------------------------------------------------------- block rendering

function tableCell(ctx, cell) {
  const content = renderInline(ctx, cell.text, 'html', true);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderListItem(ctx, item) {
  // a tight list's checkbox is a block-level token at the head of the item
  let body = item.cbHtml ? item.cbHtml : '';
  body += renderBlocks(ctx, item.tokens);
  return `<li>${body}</li>\n`;
}

function renderBlocks(ctx, blocks) {
  let out = '';
  for (const token of blocks) {
    switch (token.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${renderInline(ctx, token.text, 'html', true)}</h${token.depth}>\n`;
        break;
      case 'code': {
        const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
        // An empty code block has no content, so it must not gain a newline.
        const code = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
        const esc = escapeHtml(code, true);
        if (!langString) {
          out += '<pre><code>' + esc + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtml(langString) + '">' + esc + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (const c of token.header) cell += tableCell(ctx, c);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (const row of token.rows) {
          cell = '';
          for (const c of row) cell += tableCell(ctx, c);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(ctx, token.children)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (const item of token.items) body += renderListItem(ctx, item);
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        // a loose list's checkbox goes inside the first paragraph's inline output
        out += `<p>${token.cbHtml ? token.cbHtml : ''}${renderInline(ctx, token.text, 'html', true)}</p>\n`;
        break;
      case 'text':
        out += (token.cbHtml ? token.cbHtml : '') + renderInline(ctx, token.text, 'html', true);
        break;
      default:
        throw new Error('Token with "' + token.t + '" type was not found.');
    }
  }
  return out;
}

// --------------------------------------------------------------------- parse

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(other.carriageReturn, '\n') : markdown;
  const ctx = newCtx();
  const blocks = scanBlocks(ctx, src, [], false);
  return renderBlocks(ctx, blocks);
}
