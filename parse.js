
// Fast Markdown parser — a drop-in replacement for marked 18.1.3 with
// default options (gfm: true, breaks: false, pedantic: false, async: false).
// It renders inline content directly to strings (no token objects) and
// lexes blocks with the same grammar marked uses, matching marked's output
// byte for byte, but faster.
//
// Attribution: the block/inline grammar regular expressions follow marked
// 18.1.3 (MIT, Copyright (c) 2018+ MarkedJS, Copyright (c) 2011-2018
// Christopher Jeffrey — see the "Marked" section of LICENSE); the lexer,
// parser and renderer around them are original work.
//
// Structure:
//   1. helpers (escaping, URL cleaning, label normalising, table splitting)
//   2. inline grammar (GFM) and block grammar (GFM)
//   3. inline parser (renders to HTML or plain text)
//   4. block lexer + renderer, and the parse() entry point.

// Regex builder (marked's `c`): template string/regex + named replacements.
// A replacement's source has its ^ anchors stripped (caret rule), so a
// sub-pattern can be spliced into a larger ^-anchored pattern.
const CARET = /(^|[^\\[])\^/g;
function c(tpl, flags = '') {
  let t = typeof tpl === 'string' ? tpl : tpl.source;
  const n = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(CARET, '$1');
      t = t.replace(s, o);
      return n;
    },
    getRegex() { return new RegExp(t, flags); },
  };
  return n;
}

// ---- shared constants (marked's T / other) ----
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB_CHAR = /[ \t]$/;
const NON_SPACE_CHAR = /[^ ]/;
const LEADING_SPACE_TAB = /^[ \t]+/;
const MULTIPLE_SPACE = /\s+/g;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT_REPLACE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT_REPLACE2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_REPLACE_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIMITER = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK_LINE = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE_BRACKET = /^</;
const END_ANGLE_BRACKET = />$/;
const UNICODE_ALPHANUMERIC = /[\p{L}\p{N}]/u;
const NUMERIC_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PERCENT_DECODE = /%25/g;
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
const CARRIAGE_RETURN = /\r\n|\r/g;
const SPACE_LINE = /^ +$/gm;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const TAB_CHAR_GLOBAL = /\t/g;
const NEWLINE_CHAR_GLOBAL = /\n/g;

// Dynamic block helpers (marked's listItemRegex / nextBulletRegex / ...).
// D() memoises by indent (0..3).
function memo3(fn) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = fn(n));
  };
}
const BLOCK_TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const listItemRegex = (a) => new RegExp(`^( {0,3}${a})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = memo3((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = memo3((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memo3((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRegex = memo3((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memo3((a) => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memo3((a) => new RegExp(`^ {0,${a}}>`));

// ---- helpers ----
// HTML-escape. encode=true escapes & < > " ' ; the no-encode variant leaves
// & alone when it starts a valid entity reference.
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s, encode = false) {
  if (encode) {
    if (ESCAPE_TEST.test(s)) return s.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]);
  } else if (ESCAPE_TEST_NO_ENCODE.test(s)) {
    return s.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]);
  }
  return s;
}

// Decode numeric character references only (marked's Ie): named entities
// are NOT decoded, and a bare & becomes &amp; only when a numeric reference
// is present somewhere in the string.
function unescapeNumeric(s) {
  if (!NUMERIC_REF_TEST.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Clean a URL for output (marked's he): encodeURI, keep %25 as %.
function cleanUrl(href) {
  try { return encodeURI(href).replace(PERCENT_DECODE, '%'); } catch { return null; }
}

// Normalise a link reference label (marked's F).
function normalizeLabel(s) {
  return s.trim().replace(MULTIPLE_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket that balances the opening one
// (marked's ke): -1 = none, -2 = unclosed.
function findClosingBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (--depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Strip trailing characters (marked's L): with `not` false, strips chars
// equal to `ch`; with `not` true, strips chars different from `ch`.
function stripTrailingChar(s, ch, not = false) {
  const n = s.length;
  if (n === 0) return '';
  let c = 0;
  while (c < n) {
    const r = s.charAt(n - c - 1);
    if (r === ch && !not) c++;
    else if (r !== ch && not) c++;
    else break;
  }
  return s.slice(0, n - c);
}

// Strip trailing blank lines, keeping at most two (marked's ge).
function stripTrailingBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the column (marked's J).
function expandTabs(s, start = 0) {
  let col = start, out = '';
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (col % 4); out += ' '.repeat(r); col += r; }
    else { out += ch; col++; }
  }
  return out;
}

// Split a table row into cells (marked's de).
function splitCells(row, count) {
  const t = row.replace(FIND_PIPE, (r, o, s) => {
    let esc = false, p = o;
    while (--p >= 0 && s[p] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// Does the text contain a link (marked's linkInText)? Used by the masking.
function linkInText(e, links) {
  if (!e.includes('[')) return false;
  for (const m of e.matchAll(I_BLOCK_SKIP)) {
    if (I_LINK.test(m[0]) && e.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of e.matchAll(I_REFLINK_SEARCH)) {
    if (Object.prototype.hasOwnProperty.call(links, normalizeLabel(m[0].slice(m[0].lastIndexOf('[') + 1, -1)))) return true;
  }
  return false;
}

// ---- inline grammar (GFM, marked 18.1.3; patterns extracted verbatim
// from the marked 18.1.3 grammar so output matches byte for byte) ----
const I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const I_TEXT = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
const I_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const I_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const I_LDELIM_GFM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const I_RDELIM_AST_GFM = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const I_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const I_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const I_DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const I_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const I_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const I_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const I_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const I_TEXT_GFM = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const I_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const LABEL_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_REF_SEARCH = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LABEL_SEARCH = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const I_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const I_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const I_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const I_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCTUATION = /^((?![*_])[\s\p{P}\p{S}])/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const TAG_COMMENT = /<!--(?:-?>|[\s\S]*?-->)/;

/* ---------------- inline parsing ---------------- */

// Sticky variant of a ^-anchored regex: the 'y' flag anchors at lastIndex,
// so start-of-string anchors are stripped (also after '|' and '(').
function toSticky(re) {
  let src = re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { out += src.slice(i, i + 2); i++; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '^' && !inClass && (i === 0 || src[i - 1] === '|' || src[i - 1] === '(')) continue;
    out += ch;
  }
  return new RegExp(out, re.flags.replace('g', '').replace('m', '') + 'y');
}

// Global variant with start anchors stripped (for forward scanning).
function toGlobal(re) {
  let src = re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { out += src.slice(i, i + 2); i++; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '^' && !inClass && (i === 0 || src[i - 1] === '|' || src[i - 1] === '(')) continue;
    out += ch;
  }
  return new RegExp(out, re.flags.includes('g') ? re.flags : re.flags + 'g');
}

const S_ESCAPE = toSticky(I_ESCAPE);
const S_TAG = toSticky(I_TAG);
const S_LINK = toSticky(I_LINK);
const S_REFLINK = toSticky(I_REFLINK);
const S_NOLINK = toSticky(I_NOLINK);
// Global variant that KEEPS the start anchor: the RDelim patterns begin
// with a ^-anchored alternative (^A|B|C means (^A)|(B)|(C)) that must only
// match at position 0; stripping it lets that alternative swallow closers
// anywhere (it ate the `_` after `buffer` inside a **...** span).
function toGlobalKeepAnchor(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
}
const S_LDELIM = toSticky(I_LDELIM_GFM);
const S_RDELIM_AST = toGlobalKeepAnchor(I_RDELIM_AST_GFM);
const S_RDELIM_UND = toGlobalKeepAnchor(I_RDELIM_UND);
const S_CODE = toSticky(I_CODE);
const S_BR = toSticky(I_BR);
const S_DEL_LDELIM = toSticky(I_DEL_LDELIM);
const S_DEL_RDELIM = toGlobalKeepAnchor(I_DEL_RDELIM);
const S_AUTOLINK = toSticky(I_AUTOLINK);
const S_URL = toSticky(I_URL);
const S_TEXT = toSticky(I_TEXT_GFM);
const S_PUNCT = PUNCTUATION;

// The emStrong/del masking (marked's Lexer #n): hide reference-link labels,
// code spans, links and HTML tags so delimiters inside them cannot act as
// emphasis closers. Returns the masked source.
function maskInline(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskReflink = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.prototype.hasOwnProperty.call(links, normalizeLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(I_REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(I_REFLINK_SEARCH, maskReflink);
  }
  t = t.replace(I_PUNCT_OUTSIDE_CODE, (m, s, r) => r ? '+'.repeat(m.length) : s ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s : m);
  t = t.replace(I_BLOCK_SKIP, (m, s, r) => { const o = r ? r.length : 0; return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']'; });
  return t;
}

// Last possible closer indices in the masked source (marked's fe): the
// start index of the last delimiter run whose preceding char is not
// whitespace (space, tab, newline, CR, FF).
function maskBackslash(masked) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (r === '~') lastDel = s;
      else last[r] = s;
    }
    s = i - 1;
  }
  return { em: last, del: lastDel };
}

// Inline parser state, shared across recursive calls (mirrors marked's
// Lexer.state): inLink / inRawBlock / linkEmitted / linkParenPossible.
function newInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
}

// Shared link/image construction (marked's De): parse the label's inline
// content, honouring the no-nested-links rule. `txt` renders the label as
// plain text (for image alt text, which uses marked's text renderer).
function buildLink(match, href, title, isImage, links, st, txt) {
  const label = match[1].replace(/\\([\[\]])/g, '$1');
  const prevInLink = st.inLink;
  const prevEmitted = st.linkEmitted;
  const prevRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // Image alt text is rendered with marked's text renderer (plain text),
  // link text with the normal renderer.
  const inner = inlineHtml(label, links, st, txt || isImage);
  const emitted = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!isImage) {
    if (emitted) { st.inRawBlock = prevRaw; return null; }
    st.linkEmitted = true;
  }
  return { isImage, href, title, inner };
}

function renderLink(node, auto) {
  if (node.isImage) {
    const src = cleanUrl(node.href);
    if (src === null) return escapeHtml(node.inner);
    let out = `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.inner)}"`;
    if (node.title) out += ` title="${escapeHtml(node.title)}"`;
    return out + '>';
  }
  const href = cleanUrl(node.href);
  if (href === null) return node.inner;
  let out = `<a href="${escapeHtml(href, auto)}"`;
  if (node.title) out += ` title="${escapeHtml(node.title)}"`;
  return out + '>' + node.inner + '</a>';
}

// Whether the label text contains an HTML tag or autolink that extends
// past the label's end (marked's Be): then the link is not formed.
function labelHasRunawayTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      S_CODE.lastIndex = offset + i;
      const m = S_CODE.exec(src);
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    S_TAG.lastIndex = 0;
    S_AUTOLINK.lastIndex = 0;
    const m = S_TAG.exec(rest) || S_AUTOLINK.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Try an inline link at src[pos]. Returns {node, len} or null.
function tryLink(src, pos, links, st, txt) {
  if (!st.linkParenPossible) return null;
  S_LINK.lastIndex = pos;
  const t = S_LINK.exec(src);
  if (!t) return null;
  const isImage = t[0].charAt(0) === '!';
  const labelOff = isImage ? 2 : 1;
  if (labelHasRunawayTag(src, t[1], pos + labelOff)) return null;
  let href = t[2].trim();
  if (href.charAt(0) === '<') {
    if (href.charAt(href.length - 1) !== '>') return null;
    let l = stripTrailingChars(href.slice(0, -1), '\\');
    if ((href.length - l.length) % 2 === 0) return null;
  } else {
    const l = findClosingBracket(t[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = stripTrailingChars(t[0].slice(0, -1), '\\');
  if ((t[0].length - r.length) % 2 === 0) return null;
  let title = t[3] ? t[3].slice(1, -1) : '';
  // Re-read the href after the paren truncation above (marked reads t[2]
  // after truncating it).
  href = t[2].trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  const node = buildLink(t, href.replace(/\\([\p{P}\p{S}])/gu, '$1'),
    title.replace(/\\([\p{P}\p{S}])/gu, '$1'), isImage, links, st, txt);
  if (!node) return null;
  return { node, len: t[0].length };
}

// Try a reference link at src[pos]. Returns {node, len} or null; on a
// missing reference it returns a one-char text node (marked's behaviour).
function tryRefLink(src, pos, links, st, txt) {
  S_REFLINK.lastIndex = pos;
  let t = S_REFLINK.exec(src);
  if (!t) {
    S_NOLINK.lastIndex = pos;
    t = S_NOLINK.exec(src);
    if (!t) return null;
  }
  const isImage = t[0].charAt(0) === '!';
  const labelOff = isImage ? 2 : 1;
  if (labelHasRunawayTag(src, t[1], pos + labelOff)) return null;
  const ref = links[normalizeLabel(t[2] || t[1])];
  if (!ref) {
    const ch = t[0].charAt(0);
    return { text: ch, len: 1 };
  }
  const node = buildLink(t, ref.href, ref.title || '', isImage, links, st, txt);
  if (!node) return null;
  return { node, len: t[0].length };
}

// Strip trailing `ch` chars (marked's L with no third arg).
function stripTrailingChars(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// marked's emStrong: at src[pos] sits a * or _ run; find its closer in the
// masked source and return the em/strong HTML, or null.
function tryEmStrong(src, masked, pos, lastPossible, prevChar, links, st, txt) {
  S_LDELIM.lastIndex = pos;
  const s = S_LDELIM.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevChar === r;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const before = masked.slice(Math.max(0, l - 2), l);
  const p = before.length ? [...before].at(-1) : '';
  const h = p === '*' || p === '_' || S_PUNCT.test(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : S_PUNCT.test(n);
  if (s[4] && UNICODE_ALPHANUMERIC.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? S_RDELIM_AST : S_RDELIM_UND;
    const v = lastPossible[r];
    const Q = i + k;
    if (v < Q) return null;
    // Marked slices the masked source at Q, so the RDelim ^-anchored
    // alternative applies at the scan start, not at position 0.
    const sliced = masked.slice(Q);
    const ee = v - Q;
    A.lastIndex = 0;
    let m2;
    for (; (m2 = A.exec(sliced)) !== null && !(m2.index > ee);) {
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      const b = [...g].length;
      if (m2[3] || m2[4]) { m += b; continue; }
      if (m2[5] || m2[6] || R) {
        if (o && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const blen = Math.min(b, b + m + f);
      const te = [...m2[0]][0].length;
      const end = Q + m2.index + te + blen;
      const raw = src.slice(pos, end);
      if (Math.min(k, blen) % 2) {
        const inner = raw.slice(1, -1);
        const html = txt ? inlineHtml(inner, links, st, txt) : `<em>${inlineHtml(inner, links, st)}</em>`;
        return { html, len: raw.length };
      }
      const inner = raw.slice(2, -2);
      const html = txt ? inlineHtml(inner, links, st, txt) : `<strong>${inlineHtml(inner, links, st)}</strong>`;
      return { html, len: raw.length };
    }
  }
  return null;
}

// marked's del: at src[pos] sits a ~ run; find its closer.
function tryDel(src, masked, pos, lastPossibleDel, prevChar, links, st, txt) {
  S_DEL_LDELIM.lastIndex = pos;
  const s = S_DEL_LDELIM.exec(src);
  if (!s) return null;
  // Opener condition: following char not punct, or no char before, or
  // char before is whitespace/punct.
  if ((s[1] || '') && prevChar && !S_PUNCT.test(prevChar)) return null;
  const o = [...s[0]].length - 1;
  let p = o;
  const v = lastPossibleDel;
  const Q = pos + o;
  if (v < Q) return null;
  // Slice the masked source at Q (marked's del does the same), so the
  // RDelim ^-anchored alternative applies at the scan start.
  const sliced = masked.slice(Q);
  const ee = v - Q;
  S_DEL_RDELIM.lastIndex = 0;
  let m2;
  for (; (m2 = S_DEL_RDELIM.exec(sliced)) !== null && !(m2.index > ee);) {
    const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (m2[3] || m2[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    const llen = Math.min(l, l + p);
    const te = [...m2[0]][0].length;
    const end = Q + m2.index + te + llen;
    const raw = src.slice(pos, end);
    const inner = raw.slice(o, -o);
    const html = txt ? inlineHtml(inner, links, st, txt) : `<del>${inlineHtml(inner, links, st)}</del>`;
    return { html, len: raw.length };
  }
  return null;
}

// Main inline renderer: src -> HTML string (or plain text when txt is set,
// which is how marked's text renderer works for image alt text).
function inlineHtml(src, links, st, txt = false) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskInline(src, links) : src;
  const lastPossible = needsMask ? maskBackslash(masked) : { em: { '*': -1, '_': -1 }, del: -1 };
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  try {
    const out = [];
    let pos = 0;
    let prevChar = '';
    let prevWasText = false;
    const n = src.length;
    while (pos < n) {
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      const ch = src[pos];
      let m;
      // escape: \ + punctuation
      S_ESCAPE.lastIndex = pos;
      if ((m = S_ESCAPE.exec(src))) {
        out.push(txt ? m[1] : escapeHtml(m[1]));
        pos += m[0].length;
        continue;
      }
      // inline HTML tag
      S_TAG.lastIndex = pos;
      if ((m = S_TAG.exec(src))) {
        const tag = m[0];
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        out.push(tag);
        pos += tag.length;
        continue;
      }
      // inline / reference link
      if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
        const hit = tryLink(src, pos, links, st, txt);
        if (hit) { out.push(txt ? hit.node.inner : renderLink(hit.node)); pos += hit.len; continue; }
        const ref = tryRefLink(src, pos, links, st, txt);
        if (ref) {
          if (ref.node) { out.push(txt ? ref.node.inner : renderLink(ref.node)); pos += ref.len; }
          else { out.push(txt ? ref.text : escapeHtml(ref.text)); pos += ref.len; }
          continue;
        }
      }
      // emphasis / strong
      if (ch === '*' || ch === '_') {
        const hit = tryEmStrong(src, masked, pos, lastPossible.em, prevChar, links, st, txt);
        if (hit) { out.push(hit.html); pos += hit.len; continue; }
      }
      // code span
      S_CODE.lastIndex = pos;
      if ((m = S_CODE.exec(src))) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
          text = text.substring(1, text.length - 1);
        }
        out.push(txt ? text : `<code>${escapeHtml(text, true)}</code>`);
        pos += m[0].length;
        continue;
      }
      // hard break: two spaces or backslash before newline
      S_BR.lastIndex = pos;
      if ((m = S_BR.exec(src))) {
        if (!txt) out.push('<br>');
        pos += m[0].length;
        continue;
      }
      // strikethrough
      if (ch === '~') {
        const hit = tryDel(src, masked, pos, lastPossible.del, prevChar, links, st, txt);
        if (hit) { out.push(hit.html); pos += hit.len; continue; }
      }
      // autolink <...>
      S_AUTOLINK.lastIndex = pos;
      if ((m = S_AUTOLINK.exec(src))) {
        let text, href;
        if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
        else { text = m[1]; href = text; }
        const clean = cleanUrl(href);
        out.push(txt ? text : (clean === null ? escapeHtml(text, true) : `<a href="${escapeHtml(clean, true)}">${escapeHtml(text, true)}</a>`));
        pos += m[0].length;
        continue;
      }
      // extended autolink (www. / scheme:// / email), not inside a link
      if (!st.inLink) {
        S_URL.lastIndex = pos;
        if ((m = S_URL.exec(src))) {
          let raw = m[0];
          if (m[2] === '@') {
            const clean = cleanUrl('mailto:' + raw);
            out.push(txt ? raw : (clean === null ? escapeHtml(raw, true) : `<a href="${escapeHtml(clean, true)}">${escapeHtml(raw, true)}</a>`));
            pos += raw.length;
          } else {
            let r;
            do { r = raw; raw = I_BACKPEDAL.exec(raw)?.[0] ?? ''; } while (r !== raw);
            const href = m[1] === 'www.' ? 'http://' + raw : raw;
            const clean = cleanUrl(href);
            out.push(txt ? raw : (clean === null ? escapeHtml(raw, true) : `<a href="${escapeHtml(clean, true)}">${escapeHtml(raw, true)}</a>`));
            pos += raw.length;
          }
          continue;
        }
      }
      // plain text up to the next special character
      S_TEXT.lastIndex = pos;
      m = S_TEXT.exec(src);
      if (m) {
        const raw = m[0];
        const v = st.inRawBlock ? raw : unescapeNumeric(raw);
        out.push(txt || st.inRawBlock ? v : escapeHtml(v));
        if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
        prevWasText = true;
        pos += raw.length;
        continue;
      }
      // Should not happen; avoid an infinite loop.
      out.push(txt ? src[pos] : escapeHtml(src[pos]));
      pos++;
    }
    return out.join('');
  } finally {
    st.linkParenPossible = savedParen;
  }
}

// ---- block grammar (GFM, marked 18.1.3; patterns extracted verbatim
// from the marked 18.1.3 grammar so output matches byte for byte) ----
const B_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const B_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const B_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const B_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const B_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const B_TEXT = /^[^\n]+/;
const B_BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const B_LIST = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const B_HTML = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i;
const B_DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const B_TABLE = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
const B_LHEADING = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const B_PARAGRAPH = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const B_BLOCKQUOTE = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;

// ---- block tokenizers (each returns a token or null) ----
function tokSpace(src) {
  const t = B_NEWLINE.exec(src);
  if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  return null;
}
function tokCode(src) {
  const t = B_CODE.exec(src);
  if (!t) return null;
  const raw = stripTrailingBlankLines(t[0]);
  return { type: 'code', raw, text: raw.replace(CODE_REMOVE_INDENT, '') };
}
function tokFences(src) {
  const t = B_FENCES.exec(src);
  if (!t) return null;
  const raw = t[0];
  // Dt: if the fence is indented, remove that indent from each code line.
  let text = t[3] || '';
  const m = raw.match(INDENT_CODE_COMP);
  if (m !== null) {
    const s = m[1];
    text = text.split('\n').map((r) => {
      const o = r.match(BEGINNING_SPACE);
      if (o === null) return r;
      return r.slice(Math.min(o[0].length, s.length));
    }).join('\n');
  }
  return {
    type: 'code',
    raw,
    lang: t[2] ? t[2].trim().replace(I_ANY_PUNCT, '$1') : t[2],
    text,
  };
}
function tokHeading(src) {
  const t = B_HEADING.exec(src);
  if (!t) return null;
  let text = t[2].trim();
  if (ENDING_HASH.test(text)) {
    const s = stripTrailingChar(text, '#');
    if (!s || ENDING_SPACE_TAB_CHAR.test(s)) text = s.trim();
  }
  return { type: 'heading', raw: stripTrailingChar(t[0], '\n'), depth: t[1].length, text };
}
function tokHr(src) {
  const t = B_HR.exec(src);
  if (!t) return null;
  return { type: 'hr', raw: stripTrailingChar(t[0], '\n') };
}
function tokHtml(src) {
  const t = B_HTML.exec(src);
  if (!t) return null;
  const raw = stripTrailingBlankLines(t[0]);
  return { type: 'html', raw, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: raw };
}
function tokDef(src) {
  const t = B_DEF.exec(src);
  if (!t) return null;
  if (!START_ANGLE_BRACKET.test(t[2]) && findClosingBracket(t[2], '()') !== -1) return null;
  const tag = normalizeLabel(t[1]);
  const href = t[2] ? t[2].replace(HREF_BRACKETS, '$1').replace(I_ANY_PUNCT, '$1') : '';
  const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(I_ANY_PUNCT, '$1') : t[3];
  return { type: 'def', tag, raw: stripTrailingChar(t[0], '\n'), href, title };
}
function tokTable(src) {
  const t = B_TABLE.exec(src);
  if (!t || !TABLE_DELIMITER.test(t[2])) return null;
  const headerCells = splitCells(t[1]);
  const alignCells = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  const rowLines = t[3] && t[3].trim() ? t[3].replace(TABLE_ROW_BLANK_LINE, '').split('\n') : [];
  if (headerCells.length !== alignCells.length) return null;
  const align = [];
  for (const cell of alignCells) {
    if (TABLE_ALIGN_RIGHT.test(cell)) align.push('right');
    else if (TABLE_ALIGN_CENTER.test(cell)) align.push('center');
    else if (TABLE_ALIGN_LEFT.test(cell)) align.push('left');
    else align.push(null);
  }
  const header = headerCells.map((text, i) => ({ text, header: true, align: align[i] }));
  const rows = rowLines.map((row) => splitCells(row, header.length).map((text, p) => ({ text, header: false, align: align[p] })));
  return { type: 'table', raw: stripTrailingChar(t[0], '\n'), header, align, rows };
}
function tokLheading(src) {
  const t = B_LHEADING.exec(src);
  if (!t) return null;
  return { type: 'heading', raw: stripTrailingChar(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: t[1].trim() };
}
function tokParagraph(src) {
  const t = B_PARAGRAPH.exec(src);
  if (!t) return null;
  const text = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
  return { type: 'paragraph', raw: t[0], text };
}
function tokText(src) {
  const t = B_TEXT.exec(src);
  if (!t) return null;
  return { type: 'text', raw: t[0], text: t[0] };
}

// ---- blockquote ----
function tokBlockquote(src, ctx) {
  const t = B_BLOCKQUOTE.exec(src);
  if (!t) return null;
  const lines = stripTrailingChar(t[0], '\n').split('\n');
  let s = '', r = '';
  const tokens = [];
  let n = lines;
  while (n.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < n.length; p++) {
      if (BLOCKQUOTE_START.test(n[p])) { chunk.push(n[p]); hasMarker = true; }
      else if (!hasMarker) chunk.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(BLOCKQUOTE_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
      .replace(BLOCKQUOTE_SETEXT_REPLACE, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT_REPLACE2, '');
    s = s ? `${s}\n${h}` : h;
    r = r ? `${r}\n${u}` : u;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    blockTokens(u, tokens, ctx, true);
    ctx.state.top = savedTop;
    if (n.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (k && (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'blockquote') {
      const g = k;
      const b = n.join('\n');
      const m = g.raw + '\n' + b.replace(BLOCKQUOTE_SETEXT_REPLACE2, '');
      const f = tokBlockquote(m, ctx);
      tokens[tokens.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) s = `${s}\n${A.join('\n')}`;
      r = r.substring(0, r.length - g.text.length) + f.text;
      n = n.slice(A.length);
      if (n.length > 0 && BLOCKQUOTE_START.test(n[0])) continue;
      break;
    } else if (k && k.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + n.join('\n');
      const m = tokList(b, ctx);
      tokens[tokens.length - 1] = m;
      const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        s = `${s}\n${y}`;
        r = `${r}\n${y}`;
      }
      n = n.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw: s, tokens, text: r };
}

// ---- list ----
function tokList(src, ctx) {
  const t = B_LIST.exec(src);
  if (!t) return null;
  const whole = src;
  let r = t[1].trim();
  const ordered = r.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +r.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  r = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = listItemRegex(r);
  let p = false;
  let e = src;
  while (e) {
    let isBlank = false;
    let d = '';
    const mt = itemRe.exec(e);
    if (!mt || B_HR.test(e)) break;
    const startOff = whole.length - e.length;
    e = e.substring(mt[0].length);
    const g = mt[2].split('\n', 1)[0];
    const b = mt[1].length;
    let m = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
    const f0 = e.split('\n', 1)[0];
    const y0 = !m.trim();
    let R = 0;
    if (y0) {
      R = b + 1;
    } else {
      R = m.search(NON_SPACE_CHAR);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    let y = y0;
    let f = f0;
    if (y && BLANK_LINE.test(f)) {
      e = e.substring(f.length + 1);
      isBlank = true;
    }
    if (!isBlank) {
      const v = nextBulletRegex(R);
      const Q = hrRegex(R);
      const ee = fencesBeginRegex(R);
      const te = headingBeginRegex(R);
      const M = htmlBeginRegex(R);
      const ne = blockquoteBeginRegex(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(LEADING_SPACE_TAB, (me) => expandTabs(me));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(NON_SPACE_CHAR) >= R || !f.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || m.replace(TAB_CHAR_GLOBAL, '    ').search(NON_SPACE_CHAR) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && B_LHEADING.test(`${m}\n${f}`)
            ? `    ${Z.replace(/^ {0,3}/, '')}`
            : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = whole.slice(startOff, whole.length - e.length);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (DOUBLE_BLANK_LINE.test(A)) p = true;
    }
    list.items.push({
      type: 'list_item',
      raw: A,
      task: LIST_IS_TASK.test(d),
      loose: false,
      text: d,
      tokens: [],
    });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = whole.slice(0, whole.length - e.length).trimEnd();
  // Lex each item's content (state.top = false so items use text tokens).
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(item.text, [], ctx, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.type === 'space');
      const hasBlank = spaces.length > 0 && spaces.some((g) => ANY_LINE.test(g.raw));
      list.loose = hasBlank;
    }
  }
  ctx.state.top = true;
  // Task checkboxes.
  for (const item of list.items) {
    const d0 = item.tokens[0];
    if (item.task && (d0 && (d0.type === 'text' || d0.type === 'paragraph'))) {
      item.text = item.text.replace(LIST_REPLACE_TASK, '');
      d0.raw = d0.raw.replace(LIST_REPLACE_TASK, '');
      d0.text = d0.text.replace(LIST_REPLACE_TASK, '');
      const ck = LIST_TASK_CHECKBOX.exec(item.raw);
      if (ck) {
        const g = { type: 'checkbox', raw: ck[0] + ' ', checked: ck[0] !== '[ ]' };
        item.checked = g.checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text')) {
            item.tokens[0].checkbox = g;
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: g.raw, text: '', checkbox: g });
          }
        } else {
          item.tokens.unshift(g);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tk of item.tokens) if (tk.type === 'text') tk.type = 'paragraph';
    }
  }
  return list;
}

// ---- block lexer: the main loop (marked's Lexer.blockTokens) ----
// ctx = { links, state: { top } }. `nested` is true when called from a
// blockquote (paragraphs merge with a preceding paragraph token).
function blockTokens(e, tokens, ctx, nested = false) {
  let n = nested;
  let guard = Infinity;
  while (e) {
    if (e.length < guard) guard = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    let r;
    if ((r = tokSpace(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(r);
      continue;
    }
    if ((r = tokCode(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
      } else tokens.push(r);
      continue;
    }
    if ((r = tokFences(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokHeading(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokHr(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokBlockquote(e, ctx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokList(e, ctx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokHtml(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokDef(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.raw;
      } else {
        if (!Object.prototype.hasOwnProperty.call(ctx.links, r.tag)) {
          ctx.links[r.tag] = { href: r.href, title: r.title };
        }
        tokens.push(r);
      }
      continue;
    }
    if ((r = tokTable(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokLheading(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    const o = e;
    if (ctx.state.top && (r = tokParagraph(o))) {
      const prev = tokens[tokens.length - 1];
      if (n && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
      } else tokens.push(r);
      n = o.length !== e.length;
      e = e.substring(r.raw.length);
      continue;
    }
    if ((r = tokText(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
      } else tokens.push(r);
      continue;
    }
    if (e) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
  }
  ctx.state.top = true;
  return tokens;
}

// ---- block renderer (marked's Renderer, exact output formats) ----
function renderCheckbox(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function renderBlocks(tokens, links, st) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'code': {
        const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0];
        const text = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
        const body = escapeHtml(text, true);
        out += lang
          ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`
          : `<pre><code>${body}</code></pre>\n`;
        break;
      }
      case 'heading':
        st.inRawBlock = false;
        out += `<h${tok.depth}>${inlineHtml(tok.text, links, st)}</h${tok.depth}>\n`;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens, links, st)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += renderListItem(item, links, st);
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph': {
        const cb = tok.checkbox ? renderCheckbox(tok.checkbox.checked) : '';
        st.inRawBlock = false;
        out += `<p>${cb}${inlineHtml(tok.text, links, st)}</p>\n`;
        break;
      }
      case 'text': {
        const cb = tok.checkbox ? renderCheckbox(tok.checkbox.checked) : '';
        st.inRawBlock = false;
        out += cb + inlineHtml(tok.text, links, st);
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell, links, st);
        let headRow = `<tr>\n${head}</tr>\n`;
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell, links, st);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
        break;
      }
      case 'checkbox':
        out += renderCheckbox(tok.checked);
        break;
      default:
        break;
    }
  }
  return out;
}
function renderListItem(item, links, st) {
  return `<li>${renderBlocks(item.tokens, links, st)}</li>\n`;
}
function renderTableCell(cell, links, st) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  st.inRawBlock = false;
  return `<${tag}${align}>${inlineHtml(cell.text, links, st)}</${tag}>\n`;
}

// ---- entry point ----
export function parse(markdown) {
  const src = String(markdown).replace(CARRIAGE_RETURN, '\n');
  const ctx = { links: {}, state: { top: true } };
  const tokens = blockTokens(src, [], ctx, false);
  // One shared inline state for the whole document (marked's Lexer.state):
  // inLink persists across paragraphs (an unclosed <a> tag suppresses the
  // url rule in later paragraphs); inRawBlock is reset before each
  // top-level inline parse (see renderBlocks).
  return renderBlocks(tokens, ctx.links, newInlineState());
}
