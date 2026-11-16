// Fast Markdown parser: parse(markdown) returns exactly the HTML marked 18.1.3
// renders with its default options (gfm on, breaks off, pedantic off, async off),
// byte for byte. Dependency-free ES module.
//
// The grammar regular expressions come from marked 18.1.3's published grammar
// (MIT; see THIRD-PARTY-NOTICES.md). The lexer, parser and renderer around them are original
// work, written for speed: sticky regexes over one cursor (no per-token
// substrings), module-level precompiled patterns, and no per-call class
// instantiation.
import { BLK, INL, OTH } from './grammar.js';

// ---------------------------------------------------------------------------
// Sticky regexes. marked's rules are ^-anchored and run on a shrinking
// substring; here they run on the whole source with a cursor. A ^ outside a
// character class anchors at the match position under the sticky flag, so it
// is redundant and is dropped (none of these patterns uses the m flag, and
// none uses ^ as a start-of-string test inside a group).
// ---------------------------------------------------------------------------
function stripAnchors(src) {
  let out = '';
  let inClass = false;
  let first = false; // next char is the first char of the current class (a ']' there is literal)
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      out += ch + (src[i + 1] ?? '');
      i++;
      if (inClass) first = false; // an escaped char counts as the first char
      continue;
    }
    if (!inClass && ch === '[') { inClass = true; first = true; out += ch; continue; }
    if (inClass) {
      out += ch;
      if (first) first = (ch === '^'); // '^' right after '[' is negation, not content
      else if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '^') continue;
    out += ch;
  }
  return out;
}

function sticky(re) {
  return new RegExp(stripAnchors(re.source), re.flags.replace('g', '') + 'y');
}

const SB = {}; // sticky block rules
for (const k in BLK) SB[k] = sticky(BLK[k]);
const SI = {}; // sticky inline rules
for (const k in INL) SI[k] = sticky(INL[k]);

// Dynamic rule builders (indent-parameterised), as in marked's shared
// helpers. Each returns a sticky regex; results are cached per indent
// (0..3) exactly like marked's memoised builders.
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
function memoBuilder(fn) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = fn(n));
  };
}
const listItemRegex = (bull) => new RegExp(`( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`, 'y');
const nextBulletRegex = memoBuilder((n) => new RegExp(` {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`, 'y'));
const hrRegex = memoBuilder((n) => new RegExp(` {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`, 'y'));
const fencesBeginRegex = memoBuilder((n) => new RegExp(` {0,${n}}(?:\`\`\`|~~~)`, 'y'));
const headingBeginRegex = memoBuilder((n) => new RegExp(` {0,${n}}#{1,6}(?:\\s|$)`, 'y'));
const htmlBeginRegex = memoBuilder((n) => new RegExp(` {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'iy'));
const blockquoteBeginRegex = memoBuilder((n) => new RegExp(` {0,${n}}>`, 'y'));
const listEndRegex = memoBuilder((n) => {
  const strip = (re) => re.source.replace(/^ \{0,\d+\}/, '');
  const parts = [fencesBeginRegex(n), headingBeginRegex(n), htmlBeginRegex(n), blockquoteBeginRegex(n), nextBulletRegex(n), hrRegex(n)].map(strip);
  return new RegExp(` {0,${n}}(?:${parts.join('|')})`, 'iy');
});

// Run a sticky regex at a position; null when it does not match there.
function at(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}
// Test a sticky regex against a whole (short) string from its start.
function testAt(re, str) {
  re.lastIndex = 0;
  return re.test(str);
}

// ---------------------------------------------------------------------------
// Small helpers (same behaviour as marked's).
// ---------------------------------------------------------------------------
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape HTML. encode=true also escapes & (for code spans, hrefs, ...).
function esc(s, encode) {
  if (encode) {
    if (OTH.escapeTest.test(s)) return s.replace(OTH.escapeReplace, (c) => ENT[c]);
  } else if (OTH.escapeTestNoEncode.test(s)) {
    return s.replace(OTH.escapeReplaceNoEncode, (c) => ENT[c]);
  }
  return s;
}
// Decode numeric character references; a bare & becomes &amp;.
function unesc(s) {
  if (!OTH.numericCharacterReference.test(s)) return s;
  return s.replace(OTH.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
// Sanitise a URL the way marked's cleanUrl does; null when it cannot encode.
function cleanUrl(href) {
  try { return encodeURI(href).replace(OTH.percentDecode, '%'); } catch { return null; }
}
// Split a table row on unescaped pipes, trimming cells and padding/truncating.
function splitCells(row, count) {
  const t = row.replace(OTH.findPipe, (m, off, str) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(OTH.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(OTH.slashPipe, '|');
  return cells;
}
// Trim trailing characters equal to `ch` (or, when inv, not equal to it).
function rtrim(s, ch, inv) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !inv) k++;
    else if (c !== ch && inv) k++;
    else break;
  }
  return s.slice(0, n - k);
}
// Drop trailing blank lines, keeping at most one trailing newline.
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && OTH.blankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
// Normalise a link reference label (CommonMark: collapse whitespace, case-fold).
function normLabel(s) {
  return s.trim().replace(OTH.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Find the closing bracket/paren, honouring backslash escapes. -1: none,
// -2: unclosed.
function findClosing(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
// Expand tabs to spaces (tab stops every 4 columns from `col`).
function expandTabs(s, col = 0) {
  let n = col;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const r = 4 - (n % 4);
      out += ' '.repeat(r);
      n += r;
    } else { out += c; n++; }
  }
  return out;
}
// Compensate fenced-code indentation (marked's fences helper).
function fencesIndent(raw, code) {
  const m = raw.match(OTH.indentCodeCompensation);
  if (m === null) return code;
  const pad = m[1];
  return code.split('\n').map((line) => {
    const sp = line.match(OTH.beginningSpace);
    if (sp === null) return line;
    return line.slice(Math.min(sp[0].length, pad.length));
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Emphasis/delimiter masking. Before scanning inline tokens, marked rewrites
// the source with link labels, code spans and tags replaced by placeholder
// 'a's of the same length, so a * _ or ~ inside them can never close an
// emphasis run. The mask is recomputed per inline tokenisation and cached on
// a stack (one entry per nested inline pass).
// ---------------------------------------------------------------------------
function computeMask(src) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === c;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') del = i;
      else em[c] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, em, del };
}
function maskPush(st, maskedSrc) { st.masks.push(computeMask(maskedSrc)); }
function maskPop(st) { st.masks.pop(); }
function lastEmCloser(st, maskedSrc, delim) {
  const top = st.masks.at(-1);
  if (top && top.maskedSrc === maskedSrc) return top.em[delim];
  return computeMask(maskedSrc).em[delim];
}
function lastDelCloser(st, maskedSrc) {
  const top = st.masks.at(-1);
  if (top && top.maskedSrc === maskedSrc) return top.del;
  return computeMask(maskedSrc).del;
}
// The masked source for an inline tokenisation (marked's #n).
function maskSrc(st, src) {
  let t = src;
  if (st.links && src.includes('[')) {
    const re = INL.reflinkSearch;
    const sub = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(st.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(st, inner)) return '[' + inner.replace(re, sub) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, sub);
  }
  t = t.replace(INL.anyPunctuationOutsideCode, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(INL.blockSkip, (n, s, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']'; });
  }
  return t;
}
// Build a link/image token from a regex match and a resolved reference.
function makeLink(st, m, ref, raw) {
  const href = ref.href;
  const title = ref.title || null;
  const text = m[1].replace(OTH.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const saveLink = st.inLink;
  const saveEmitted = st.linkEmitted;
  const saveRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const tokens = inlineTokens(st, text, []);
  const nested = st.linkEmitted;
  st.linkEmitted = saveEmitted;
  st.inLink = saveLink;
  if (!isImage) {
    if (nested) { st.inRawBlock = saveRaw; return null; }
    st.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}
// Does `src` contain a link (used while masking, to keep link labels opaque)?
function linkInText(st, src) {
  if (!src.includes('[')) return false;
  const linkRe = INL.link;
  for (const n of src.matchAll(INL.blockSkip)) {
    if (linkRe.test(n[0]) && src.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of src.matchAll(INL.reflinkSearch)) {
    const s = n[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(st.links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(st, s.slice(1, r - 1)))) return true;
  }
  return false;
}
// Does the link label contain a tag/autolink that runs past the label's end?
// If so the link is not a link (CommonMark: a link label may not contain an
// unescaped < that opens a tag or autolink extending beyond it).
function hasTagOrAutolink(st, src, pos, label, bang) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = INL.code.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(pos + bang + s);
    const o = INL.tag.exec(rest) || INL.autolink.exec(rest);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes (st, src, pos) and returns a token or null.
// ---------------------------------------------------------------------------
function tokEscape(st, src, pos) {
  const m = at(SI.escape, src, pos);
  if (!m) return null;
  return { type: 'escape', raw: m[0], text: m[1] };
}
function tokTag(st, src, pos) {
  const m = at(SI.tag, src, pos);
  if (!m) return null;
  if (!st.inLink && OTH.startATag.test(m[0])) st.inLink = true;
  else if (st.inLink && OTH.endATag.test(m[0])) st.inLink = false;
  if (!st.inRawBlock && OTH.startPreScriptTag.test(m[0])) st.inRawBlock = true;
  else if (st.inRawBlock && OTH.endPreScriptTag.test(m[0])) st.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
}
function tokLink(st, src, pos) {
  if (st.linkParenPossible === false) return null;
  const m = at(SI.link, src, pos);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagOrAutolink(st, src, pos, m[1], bang)) return null;
  const s = m[2].trim();
  if (OTH.startAngleBracket.test(s)) {
    if (!OTH.endAngleBracket.test(s)) return null;
    const l = rtrim(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findClosing(m[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (OTH.startAngleBracket.test(href)) href = href.slice(1, -1);
  return makeLink(st, m, {
    href: href && href.replace(INL.anyPunctuation, '$1'),
    title: title && title.replace(INL.anyPunctuation, '$1'),
  }, m[0]);
}
function tokReflink(st, src, pos) {
  const m = at(SI.reflink, src, pos) || at(SI.nolink, src, pos);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagOrAutolink(st, src, pos, m[1], bang)) return null;
  const ref = st.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const c = m[0].charAt(0);
    return { type: 'text', raw: c, text: c };
  }
  return makeLink(st, m, ref, m[0]);
}

// Emphasis/strong. Port of marked's emStrong: the left-delimiter regex
// consumes the run plus one following character (so k = run length); the
// closer is searched with the *global* RDelim pattern on the masked source
// sliced just past the opener (the pattern must be able to advance past a
// lone delimiter, so a sticky flag would be wrong here).
function tokEmStrong(st, src, pos, masked, prevChar) {
  const s0 = at(SI.emStrongLDelim, src, pos);
  if (!s0 || (!s0[1] && !s0[2] && !s0[3] && !s0[4])) return null;
  const r = s0[0][0];
  const o = prevChar === r;
  const i = pos;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!INL.punctuation.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!INL.punctuation.exec(n);
  if (s0[4] && n.match(OTH.unicodeAlphaNumeric)) return null;
  const d = s0[1] || s0[3] || '';
  if (!d || !n || u) {
    const k = [...s0[0]].length - 1;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || r === '*' && !h);
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? INL.emStrongRDelimAst : INL.emStrongRDelimUnd;
    const v = lastEmCloser(st, masked, r);
    const Q = i + k;
    if (v < Q) return null;
    const t = masked.slice(Q);
    const ee = v - Q;
    for (A.lastIndex = 0; ;) {
      const s = A.exec(t);
      if (s === null || s.index > ee) break;
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const b0 = [...g].length;
      if (s[3] || s[4]) { m += b0; continue; }
      if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b0) % 3)) { f += b0; continue; }
      }
      m -= b0;
      if (m > 0) continue;
      const b = Math.min(b0, b0 + m + f);
      const te = [...s[0]][0].length;
      const M = src.slice(pos, pos + k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { type: 'em', raw: M, text: U, tokens: inlineTokens(st, U, []) };
      }
      const ne = M.slice(2, -2);
      return { type: 'strong', raw: M, text: ne, tokens: inlineTokens(st, ne, []) };
    }
  }
  return null;
}
function tokCodespan(st, src, pos) {
  const m = at(SI.code, src, pos);
  if (!m) return null;
  let text = m[2].replace(OTH.newLineCharGlobal, ' ');
  const hasNonSpace = OTH.nonSpaceChar.test(text);
  const padded = OTH.startingSpaceChar.test(text) && OTH.endingSpaceChar.test(text);
  if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}
function tokBr(st, src, pos) {
  const m = at(SI.br, src, pos);
  if (!m) return null;
  return { type: 'br', raw: m[0] };
}
// Strikethrough, same LDelim/RDelim structure as emphasis.
function tokDel(st, src, pos, masked, prevChar) {
  const s0 = at(SI.delLDelim, src, pos);
  if (!s0) return null;
  if (!(s0[1] || '') || !prevChar || INL.punctuation.exec(prevChar)) {
    const o = [...s0[0]].length - 1;
    let p = o;
    const R = INL.delRDelim;
    const u = lastDelCloser(st, masked);
    const d = pos + o;
    if (u < d) return null;
    const t = masked.slice(d);
    const k = u - d;
    for (R.lastIndex = 0; ;) {
      const s = R.exec(t);
      if (s === null || s.index > k) break;
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const l0 = [...g].length;
      if (l0 !== o) continue;
      if (s[3] || s[4]) { p += l0; continue; }
      p -= l0;
      if (p > 0) continue;
      const l = Math.min(l0, l0 + p);
      const te = [...s[0]][0].length;
      const b = src.slice(pos, pos + o + s.index + te + l);
      const m = b.slice(o, -o);
      return { type: 'del', raw: b, text: m, tokens: inlineTokens(st, m, []) };
    }
  }
  return null;
}
function tokAutolink(st, src, pos) {
  const m = at(SI.autolink, src, pos);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[1]; href = 'mailto:' + m[1]; }
  else { text = m[1]; href = m[1]; }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}
function tokUrl(st, src, pos) {
  const m = at(SI.url, src, pos);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let prev;
    do { prev = m[0]; m[0] = INL._backpedal.exec(m[0])?.[0] ?? ''; } while (prev !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}
function tokInlineText(st, src, pos) {
  const m = at(SI.text, src, pos);
  if (!m) return null;
  const inRaw = st.inRawBlock;
  return { type: 'text', raw: m[0], text: inRaw ? m[0] : unesc(m[0]), escaped: inRaw };
}
// Tokenise an inline string into `tokens` (marked's Lexer.inlineTokens).
// linkParenPossible is scoped to this call and restored afterwards.
function inlineTokens(st, src, tokens) {
  const saveParen = st.linkParenPossible;
  st.linkParenPossible = saveParen && src.includes(')');
  try {
    return inlineScan(st, src, tokens);
  } finally {
    st.linkParenPossible = saveParen;
  }
}
// The masking pass plus the push/pop of the mask entry.
function inlineScan(st, src, tokens) {
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? maskSrc(st, src) : src;
  maskPush(st, masked);
  try {
    return inlineLoop(st, src, masked, tokens);
  } finally {
    maskPop(st);
  }
}
// The inline tokeniser loop (marked's Lexer.#t), driven by a cursor.
function inlineLoop(st, src, masked, tokens) {
  let pos = 0;
  const end = src.length;
  let prevText = false;
  let prevChar = '';
  let guard = Infinity;
  while (pos < end) {
    const remain = end - pos;
    if (remain < guard) guard = remain;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    if (!prevText) prevChar = '';
    prevText = false;
    const cc = src.charCodeAt(pos);
    let tok;
    if (cc === 92 || cc === 60 || cc === 91 || cc === 33 || cc === 42 || cc === 95 || cc === 96 || cc === 10 || cc === 126 || cc === 32) {
      tok = tokEscape(st, src, pos)
        || tokTag(st, src, pos)
        || tokLink(st, src, pos)
        || tokReflink(st, src, pos)
        || tokEmStrong(st, src, pos, masked, prevChar)
        || tokCodespan(st, src, pos)
        || tokBr(st, src, pos)
        || tokDel(st, src, pos, masked, prevChar)
        || tokAutolink(st, src, pos)
        || (!st.inLink && tokUrl(st, src, pos))
        || null;
    } else {
      tok = (!st.inLink && tokUrl(st, src, pos)) || null;
    }
    if (tok) {
      pos += tok.raw.length;
      if (tok.type === 'text') {
        const last = tokens.at(-1);
        if (last && last.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
      } else {
        tokens.push(tok);
      }
      continue;
    }
    const t = tokInlineText(st, src, pos);
    if (t) {
      pos += t.raw.length;
      if (t.raw.slice(-1) !== '_') prevChar = t.raw.slice(-1);
      prevText = true;
      const last = tokens.at(-1);
      if (last && last.type === 'text') { last.raw += t.raw; last.text += t.text; }
      else tokens.push(t);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Block helpers.
// ---------------------------------------------------------------------------
// Drop trailing blank lines when there are two or more (marked's ge).
function ge(a) {
  const e = a.split('\n');
  let t = e.length - 1;
  for (; t >= 0 && OTH.blankLine.test(e[t]);) t--;
  return e.length - t <= 2 ? a : e.slice(0, t + 1).join('\n');
}
// Fenced-code indent compensation (marked's Dt): remove the fence's own
// indent from each line of the code. Only ``` fences match (~~~ returns e).
function fenceIndent(raw, text) {
  const n = raw.match(OTH.indentCodeCompensation);
  if (n === null) return text;
  const s = n[1];
  return text.split('\n').map((r) => {
    const o = r.match(OTH.beginningSpace);
    if (o === null) return r;
    const [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join('\n');
}
// Queue an inline tokenisation (marked's Lexer.inline): returns the tokens
// array and records {src, tokens} for later inline processing.
function queueInline(st, src) {
  const tokens = [];
  st.queue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes (st, src, pos) and returns a token or null.
// ---------------------------------------------------------------------------
function tokSpace(st, src, pos) {
  const m = at(SB.newline, src, pos);
  if (!m || m[0].length <= 0) return null;
  return { type: 'space', raw: m[0] };
}
function tokCode(st, src, pos) {
  const m = at(SB.code, src, pos);
  if (!m) return null;
  const n = ge(m[0]);
  const s = n.replace(OTH.codeRemoveIndent, '');
  return { type: 'code', raw: n, codeBlockStyle: 'indented', text: s };
}
function tokFences(st, src, pos) {
  const m = at(SB.fences, src, pos);
  if (!m) return null;
  const n = m[0];
  const s = fenceIndent(n, m[3] || '');
  return { type: 'code', raw: n, lang: m[2] ? m[2].trim().replace(INL.anyPunctuation, '$1') : m[2], text: s };
}
function tokHeading(st, src, pos) {
  const m = at(SB.heading, src, pos);
  if (!m) return null;
  let n = m[2].trim();
  if (OTH.endingHash.test(n)) {
    const s = rtrim(n, '#');
    if (!s || OTH.endingSpaceTabChar.test(s)) n = s.trim();
  }
  return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text: n, tokens: queueInline(st, n) };
}
function tokHr(st, src, pos) {
  const m = at(SB.hr, src, pos);
  if (!m) return null;
  return { type: 'hr', raw: rtrim(m[0], '\n') };
}
function tokHtml(st, src, pos) {
  const m = at(SB.html, src, pos);
  if (!m) return null;
  const n = ge(m[0]);
  return { type: 'html', block: true, raw: n, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: n };
}
function tokDef(st, src, pos) {
  const m = at(SB.def, src, pos);
  if (!m) return null;
  if (!OTH.startAngleBracket.test(m[2]) && findClosing(m[2], '()') !== -1) return null;
  const n = normLabel(m[1]);
  const s = m[2] ? m[2].replace(OTH.hrefBrackets, '$1').replace(INL.anyPunctuation, '$1') : '';
  const r = m[3] ? m[3].substring(1, m[3].length - 1).replace(INL.anyPunctuation, '$1') : m[3];
  return { type: 'def', tag: n, raw: rtrim(m[0], '\n'), href: s, title: r };
}
function tokLheading(st, src, pos) {
  const m = at(SB.lheading, src, pos);
  if (!m) return null;
  const n = m[1].trim();
  return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text: n, tokens: queueInline(st, n) };
}
function tokParagraph(st, src, pos) {
  const m = at(SB.paragraph, src, pos);
  if (!m) return null;
  const n = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text: n, tokens: queueInline(st, n) };
}
function tokText(st, src, pos) {
  const m = at(SB.text, src, pos);
  if (!m) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(st, m[0]) };
}
function tokTable(st, src, pos) {
  const m = at(SB.table, src, pos);
  if (!m || !OTH.tableDelimiter.test(m[2])) return null;
  const n = splitCells(m[1]);
  const s = m[2].replace(OTH.tableAlignChars, '').split('|');
  const r = m[3]?.trim() ? m[3].replace(OTH.tableRowBlankLine, '').split('\n') : [];
  const o = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
  if (n.length === s.length) {
    for (const cell of s) {
      if (OTH.tableAlignRight.test(cell)) o.align.push('right');
      else if (OTH.tableAlignCenter.test(cell)) o.align.push('center');
      else if (OTH.tableAlignLeft.test(cell)) o.align.push('left');
      else o.align.push(null);
    }
    for (let i = 0; i < n.length; i++) o.header.push({ text: n[i], tokens: queueInline(st, n[i]), header: true, align: o.align[i] });
    for (const row of r) o.rows.push(splitCells(row, o.header.length).map((cell, p) => ({ text: cell, tokens: queueInline(st, cell), header: false, align: o.align[p] })));
    return o;
  }
  return null;
}

function tokBlockquote(st, src, pos) {
  const m = at(SB.blockquote, src, pos);
  if (!m) return null;
  let n = rtrim(m[0], '\n').split('\n');
  let s = '', r = '', o = [];
  for (; n.length > 0;) {
    let i = false, l = [], p;
    for (p = 0; p < n.length; p++) {
      if (OTH.blockquoteStart.test(n[p])) { l.push(n[p]); i = true; }
      else if (!i) l.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = l.join('\n');
    const u = h.replace(OTH.blockquoteMarkerWhitespace, (g, b, mm) => b + expandTabs(mm, b.length))
      .replace(OTH.blockquoteSetextReplace, '\n    $1')
      .replace(OTH.blockquoteSetextReplace2, '');
    s = s ? `${s}\n${h}` : h;
    r = r ? `${r}\n${u}` : u;
    const d = st.top;
    st.top = true;
    blockTokens(st, u, o, true);
    st.top = d;
    if (n.length === 0) break;
    const k = o.at(-1);
    if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
    if (k?.type === 'blockquote') {
      const g = k, b = n.join('\n');
      const mm = g.raw + '\n' + b.replace(OTH.blockquoteSetextReplace2, '');
      const f = tokBlockquote(st, mm, 0);
      o[o.length - 1] = f;
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) s = `${s}\n${A.join('\n')}`;
      r = r.substring(0, r.length - g.text.length) + f.text;
      n = n.slice(A.length);
      if (n.length > 0 && OTH.blockquoteStart.test(n[0])) continue;
      break;
    } else if (k?.type === 'list') {
      const g = k, b = g.raw + '\n' + n.join('\n');
      const mm = tokList(st, b, 0);
      o[o.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        s = `${s}\n${y}`;
        r = `${r}\n${y}`;
      }
      n = n.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw: s, tokens: o, text: r };
}
function tokList(st, src, pos) {
  let e = src.slice(pos);
  let t = BLK.list.exec(e);
  if (!t) return null;
  const n = e;
  const consumed = () => n.length - e.length;
  let bull = t[1].trim();
  const ordered = bull.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = listItemRegex(bull);
  let looseFlag = false;
  for (; e;) {
    let blankItem = false, text = '';
    t = at(itemRe, e, 0);
    if (!t || testAt(BLK.hr, e)) break;
    const k = consumed();
    e = e.substring(t[0].length);
    const firstLine = t[2].split('\n', 1)[0];
    const bullLen = t[1].length;
    let m = firstLine.replace(OTH.leadingSpaceTab, (v) => expandTabs(v, bullLen));
    let f = e.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = bullLen + 1;
    else {
      R = m.search(OTH.nonSpaceChar);
      R = R > 4 ? 1 : R;
      text = m.slice(R);
      R += bullLen;
    }
    if (y && OTH.blankLine.test(f)) { e = e.substring(f.length + 1); blankItem = true; }
    if (!blankItem) {
      const v = nextBulletRegex(R);
      const Q = hrRegex(R);
      const ee = fencesBeginRegex(R);
      const te = headingBeginRegex(R);
      const M = htmlBeginRegex(R);
      const le = listEndRegex(R);
      for (; e;) {
        const U = e.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(OTH.leadingSpaceTab, (me) => expandTabs(me));
        let leMatch = false;
        {
          let j = 0;
          while (j < f.length && j <= R && f.charCodeAt(j) === 32) j++;
          if (j <= R && j < f.length) {
            const c = f.charCodeAt(j);
            if (c === 96 || c === 126 || c === 35 || c === 60 || c === 62 || c === 42 || c === 43 || c === 45 || c === 95 || (c >= 48 && c <= 57)) leMatch = testAt(le, f);
          }
        }
        if (leMatch) break;
        if (Z.search(OTH.nonSpaceChar) >= R || !f.trim()) text += '\n' + Z.slice(R);
        else {
          if (y || m.replace(OTH.tabCharGlobal, '    ').search(OTH.nonSpaceChar) >= 4 || testAt(ee, m) || testAt(te, m) || testAt(M, m) || testAt(Q, m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && testAt(BLK.lheading, `${m}\n${f}`) ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
          text += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, consumed());
    if (!list.loose) {
      if (looseFlag) list.loose = true;
      else if (OTH.doubleBlankLine.test(A)) looseFlag = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: !!OTH.listIsTask.test(text), loose: false, text, tokens: [] });
  }
  const h = list.items.at(-1);
  if (h) { h.raw = h.raw.trimEnd(); h.text = h.text.trimEnd(); }
  else return null;
  list.raw = n.slice(0, consumed()).trimEnd();
  for (const u of list.items) {
    st.top = false;
    u.tokens = blockTokens(st, u.text, []);
    if (!list.loose) {
      const d = u.tokens.filter((g) => g.type === 'space');
      const kk = d.length > 0 && d.some((g) => OTH.anyLine.test(g.raw));
      list.loose = kk;
    }
  }
  for (const u of list.items) {
    const d = u.tokens[0];
    if (u.task && (d?.type === 'text' || d?.type === 'paragraph')) {
      u.text = u.text.replace(OTH.listReplaceTask, '');
      d.raw = d.raw.replace(OTH.listReplaceTask, '');
      d.text = d.text.replace(OTH.listReplaceTask, '');
      for (let g = st.queue.length - 1; g >= 0; g--) {
        if (OTH.listIsTask.test(st.queue[g].src)) {
          st.queue[g].src = st.queue[g].src.replace(OTH.listReplaceTask, '');
          break;
        }
      }
      const kk = OTH.listTaskCheckbox.exec(u.raw);
      if (kk) {
        const g = { type: 'checkbox', raw: kk[0] + ' ', checked: kk[0] !== '[ ]' };
        u.checked = g.checked;
        if (list.loose) {
          if (u.tokens[0] && ['paragraph', 'text'].includes(u.tokens[0].type) && 'tokens' in u.tokens[0] && u.tokens[0].tokens) {
            u.tokens[0].raw = g.raw + u.tokens[0].raw;
            u.tokens[0].text = g.raw + u.tokens[0].text;
            u.tokens[0].tokens.unshift(g);
          } else {
            u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
          }
        } else {
          u.tokens.unshift(g);
        }
      }
    } else if (u.task) {
      u.task = false;
    }
  }
  if (list.loose) {
    for (const u of list.items) {
      u.loose = true;
      for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// The block tokeniser loop (marked's Lexer.blockTokens), driven by a cursor.
// `tokens` is the array to fill; `mergeOk` allows a paragraph to merge into
// a previous paragraph (only true for blockquote recursion). Returns tokens.
// ---------------------------------------------------------------------------
function blockTokens(st, src, tokens, mergeOk = false) {
  let pos = 0;
  const end = src.length;
  let guard = Infinity;
  while (pos < end) {
    const remain = end - pos;
    if (remain < guard) guard = remain;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    let tok = tokSpace(st, src, pos);
    if (tok) {
      pos += tok.raw.length;
      const prev = tokens.at(-1);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    tok = tokCode(st, src, pos);
    if (tok) {
      pos += tok.raw.length;
      const prev = tokens.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.queue.at(-1).src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    tok = tokFences(st, src, pos) || tokHeading(st, src, pos) || tokHr(st, src, pos)
      || tokBlockquote(st, src, pos) || tokList(st, src, pos) || tokHtml(st, src, pos);
    if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    tok = tokDef(st, src, pos);
    if (tok) {
      pos += tok.raw.length;
      const prev = tokens.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        st.queue.at(-1).src = prev.text;
      } else {
        if (!st.links[tok.tag]) st.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    tok = tokTable(st, src, pos);
    if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    tok = tokLheading(st, src, pos);
    if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    if (st.top) {
      tok = tokParagraph(st, src, pos);
      if (tok) {
        const prev = tokens.at(-1);
        if (mergeOk && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          st.queue.pop();
          st.queue.at(-1).src = prev.text;
        } else tokens.push(tok);
        mergeOk = false;
        pos += tok.raw.length;
        continue;
      }
    }
    tok = tokText(st, src, pos);
    if (tok) {
      pos += tok.raw.length;
      const prev = tokens.at(-1);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.queue.pop();
        st.queue.at(-1).src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  st.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer (marked's Renderer + Parser), as plain functions.
// ---------------------------------------------------------------------------
function renderText(tok) {
  return 'tokens' in tok && tok.tokens ? renderInline(tok.tokens) : 'escaped' in tok && tok.escaped ? tok.text : esc(tok.text);
}
function renderCode(tok) {
  const s = (tok.lang || '').match(OTH.notSpaceStart)?.[0];
  const r = tok.text ? tok.text.replace(OTH.endingNewline, '') + '\n' : '';
  const body = tok.escaped ? r : esc(r, true);
  return s ? '<pre><code class="language-' + esc(s) + '">' + body + '</code></pre>\n'
    : '<pre><code>' + body + '</code></pre>\n';
}
function renderBlockquote(tok) { return `<blockquote>\n${renderBlock(tok.tokens)}</blockquote>\n`; }
function renderHtml(tok) { return tok.text; }
function renderHeading(tok) { return `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; }
function renderHr() { return '<hr>\n'; }
function renderList(tok) {
  let s = '';
  for (const item of tok.items) s += renderListItem(item);
  const tag = tok.ordered ? 'ol' : 'ul';
  const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
  return '<' + tag + start + '>\n' + s + '</' + tag + '>\n';
}
function renderListItem(tok) { return `<li>${renderBlock(tok.tokens)}</li>\n`; }
function renderCheckbox(tok) { return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; }
function renderParagraph(tok) { return `<p>${renderInline(tok.tokens)}</p>\n`; }
function renderTable(tok) {
  let head = '';
  for (const cell of tok.header) head += renderTableCell(cell);
  head = renderTableRow({ text: head });
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += renderTableRow({ text: cells });
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n` + head + `</thead>\n` + body + `</table>\n`;
}
function renderTableRow(tok) { return `<tr>\n${tok.text}</tr>\n`; }
function renderTableCell(tok) {
  const t = renderInline(tok.tokens);
  const tag = tok.header ? 'th' : 'td';
  return (tok.align ? `<${tag} align="${tok.align}">` : `<${tag}>`) + t + `</${tag}>\n`;
}
function renderStrong(tok) { return `<strong>${renderInline(tok.tokens)}</strong>`; }
function renderEm(tok) { return `<em>${renderInline(tok.tokens)}</em>`; }
function renderCodespan(tok) { return `<code>${esc(tok.text, true)}</code>`; }
function renderBr() { return '<br>'; }
function renderDel(tok) { return `<del>${renderInline(tok.tokens)}</del>`; }
function renderLink(tok) {
  const o = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
  const i = cleanUrl(tok.href);
  if (i === null) return o;
  const e = esc(i, tok.autolink);
  let l = '<a href="' + e + '"';
  if (tok.title) l += ' title="' + esc(tok.title) + '"';
  l += '>' + o + '</a>';
  return l;
}
function renderImage(tok) {
  let n = tok.text;
  if (tok.tokens) n = renderInline(tok.tokens, textRenderer);
  const r = cleanUrl(tok.href);
  if (r === null) return esc(n);
  const e = r;
  let o = `<img src="${esc(e)}" alt="${esc(n)}"`;
  if (tok.title) o += ` title="${esc(tok.title)}"`;
  o += '>';
  return o;
}
// Plain-text renderer for image alt text (marked's textRenderer).
const textRenderer = {
  strong: (tok) => tok.tokens ? renderInline(tok.tokens, textRenderer) : tok.text,
  em: (tok) => tok.tokens ? renderInline(tok.tokens, textRenderer) : tok.text,
  codespan: (tok) => tok.text,
  del: (tok) => tok.tokens ? renderInline(tok.tokens, textRenderer) : tok.text,
  html: (tok) => tok.text,
  text: (tok) => tok.text,
  link: (tok) => tok.tokens ? renderInline(tok.tokens, textRenderer) : tok.text,
  image: (tok) => tok.tokens ? renderInline(tok.tokens, textRenderer) : tok.text,
  br: () => '',
  checkbox: (tok) => tok.raw,
};
// Normal inline renderer.
const inlineRenderer = {
  html: renderHtml,
  link: renderLink,
  image: renderImage,
  checkbox: renderCheckbox,
  strong: renderStrong,
  em: renderEm,
  codespan: renderCodespan,
  br: renderBr,
  del: renderDel,
  text: renderText,
};
// Block renderer (marked's Parser.parse).
function renderBlock(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += renderHeading(tok); break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += renderBlockquote(tok); break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += renderHtml(tok); break;
      case 'def': break;
      case 'paragraph': out += renderParagraph(tok); break;
      case 'text': out += renderText(tok); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}
// Inline renderer (marked's Parser.parseInline). `renderer` is the normal
// inline renderer by default, or the plain-text renderer for image alt text.
// An escape token is rendered through the renderer's text method.
function renderInline(tokens, renderer) {
  const r = renderer || inlineRenderer;
  let out = '';
  for (const tok of tokens) {
    if (tok.type === 'escape') { out += r.text(tok); continue; }
    const fn = r[tok.type];
    if (!fn) throw new Error('Token with "' + tok.type + '" type was not found.');
    out += fn(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point. Normalises line endings, runs the block lexer, then the
// queued inline tokenisations (in order), then renders.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const src = markdown.replace(OTH.carriageReturn, '\n');
  const st = {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    masks: [],
    queue: [],
  };
  const tokens = [];
  blockTokens(st, src, tokens);
  for (const entry of st.queue) {
    st.inRawBlock = false;
    inlineTokens(st, entry.src, entry.tokens);
  }
  return renderBlock(tokens);
}
