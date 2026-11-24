// Text a token contract chose for itself (its name, its symbol) is not ours to trust: it can hide
// characters a reader cannot see, or copy a ticker with letters from another script that look
// the same. visibleText and tokenText are ported from blazephoenix-mcp src/text.ts (main);
// lookalike is new here.

/** What a reader cannot see, removed from any string. "Cannot see" is Unicode properties, not a
 *  list: control characters (Cc), format characters (Cf), every default-ignorable code point and
 *  a lone surrogate. Tags go without a trace, the rest becomes a space. Line feed and tab stay. */
export function visibleText(s: string): string {
  return s
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/(?![\t\n])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ' ')
    .replace(/\p{Cs}/gu, ' ');
}

/** A string a token contract chose: `visibleText`, then whitespace collapsed and length capped;
 *  a cap inside a surrogate pair drops the half. */
export function tokenText(s: unknown, max = 64): string {
  const t = visibleText(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max).replace(/\p{Cs}$/u, '')}…` : t;
}

/** Letters of other scripts that render like an ASCII letter or digit (a subset of the Unicode
 *  confusables table: the Cyrillic, Greek and Armenian forms used to copy tickers). */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u043A': 'k', '\u043C': 'm', '\u043D': 'h', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't',
  '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w', '\u04BB': 'h', '\u04CF': 'l',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0423': 'Y', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u04AE': 'Y', '\u0500': 'D', '\u051A': 'Q', '\u051C': 'W', '\u04C0': 'I',
  // Greek
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03BF': 'o', '\u03BD': 'v', '\u03B9': 'i', '\u03BA': 'k', '\u03C1': 'p', '\u03C4': 't',
  '\u03C5': 'u', '\u03C7': 'x', '\u03B1': 'a',
  // Armenian
  '\u0585': 'o', '\u057D': 'u', '\u0581': 'g', '\u0570': 'h', '\u0578': 'n', '\u054F': 'S', '\u0555': 'O',
};

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Cherokee', 'Georgian', 'Coptic', 'Arabic', 'Hebrew', 'Han',
  'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Devanagari'] as const;
const SCRIPT_RE = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')] as const);

export interface LookalikeReport {
  /** true when any reason below holds. A warning, not a verdict. */
  suspicious: boolean;
  /** Fixed sentences: hidden characters, mixed scripts, confusable letters, compatibility forms. */
  reasons: string[];
  /** Scripts the visible letters belong to (Common and Inherited left out). */
  scripts: string[];
  /** The text folded to ASCII where a letter has a known lookalike, NFKC, upper case: two strings
   *  with the same skeleton read the same to a person. */
  skeleton: string;
}

/** The ASCII reading of a string: NFKC (fullwidth and mathematical letters become plain ones),
 *  confusable letters mapped to the ASCII letter they copy, invisible characters dropped, upper case. */
export function skeleton(s: unknown): string {
  const v = tokenText(s, 256).normalize('NFKC');
  let out = '';
  for (const ch of v) out += CONFUSABLE[ch] ?? ch;
  return out.replace(/\s+/g, '').toUpperCase();
}

/** Does this text (a symbol or name a contract chose) look like something it is not? */
export function lookalike(s: unknown): LookalikeReport {
  const raw = String(s ?? '');
  const reasons: string[] = [];
  if (tokenText(raw, raw.length + 1) !== raw.replace(/\s+/g, ' ').trim()) reasons.push('hidden characters: invisible or control characters were removed');
  const vis = tokenText(raw, 256);
  const scripts: string[] = [];
  for (const ch of vis) for (const [name, re] of SCRIPT_RE) if (re.test(ch) && !scripts.includes(name)) scripts.push(name);
  if (scripts.length > 1) reasons.push(`mixed scripts: ${scripts.join(' + ')}`);
  const conf = [...vis].filter((ch) => CONFUSABLE[ch] !== undefined);
  if (conf.length > 0) reasons.push(`confusable letters: ${conf.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')} look like ASCII ${conf.map((c) => CONFUSABLE[c]).join('')}`);
  if (vis.normalize('NFKC') !== vis) reasons.push('compatibility forms: fullwidth, mathematical or other letters that fold to plain ones');
  return { suspicious: reasons.length > 0, reasons, scripts, skeleton: skeleton(raw) };
}
