/**
 * Smart formatting pass for transcribed text.
 *
 * Runs AFTER voice-command extraction and BEFORE grammar correction.
 * Converts common spoken patterns into their written form:
 *   "alice at example dot com"       → "alice@example.com"
 *   "w w w dot example dot com"      → "www.example.com"
 *   "https colon slash slash foo"    → "https://foo"
 *   "hashtag productivity"           → "#productivity"
 *   "at username alice"              → "@alice"
 *   "two one three four five six"    → "213456"  (run of spoken digits)
 *   "heading one introduction"       → "# introduction"
 *
 * All rules are pure string transforms. No external data sources —
 * privacy-safe for lawyer/accountant content. Callers can disable
 * the whole pass via the `smartFormat` setting.
 */

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  oh: "0",
};

/** Collapse runs of three or more spoken digits into a numeric string. */
function collapseDigitRuns(input: string): string {
  const words = input.split(/\s+/);
  const out: string[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length >= 3) {
      out.push(run.map((t) => DIGIT_WORDS[t.toLowerCase()]).join(""));
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const word of words) {
    const key = word.replace(/[.,!?;:]+$/g, "").toLowerCase();
    if (key && DIGIT_WORDS[key] !== undefined) {
      run.push(word);
    } else {
      if (run.length) flush();
      out.push(word);
    }
  }
  if (run.length) flush();
  return out.join(" ");
}

/** Email addresses spoken as "X at Y dot Z". */
function formatEmails(input: string): string {
  // word "at" between two word-ish tokens → '@'; propagate "dot" → '.' on both sides.
  const re =
    /([A-Za-z0-9._%+-]+)\s+at\s+([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+)/gi;
  return input.replace(re, (_m, local: string, domain: string) => {
    const dom = domain.replace(/\s+dot\s+/gi, ".");
    return local + "@" + dom;
  });
}

/** URLs spoken as "w w w dot foo dot com" or "https colon slash slash foo dot com". */
function formatUrls(input: string): string {
  // "w w w" / "www" → "www"
  let out = input.replace(/\bw\s+w\s+w\b/gi, "www");

  // "https colon slash slash" → "https://" (swallow trailing whitespace so
  // the next host token sits flush against the scheme).
  out = out.replace(/\b(https?)\s+colon\s+slash\s+slash\s*/gi, (_m, scheme) =>
    scheme.toLowerCase() + "://"
  );

  // "hostname dot tld" runs — hostname-ish tokens separated by "dot"
  out = out.replace(
    /\b([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+){1,})\b/gi,
    (m) => {
      // Avoid double-joining when we already emitted an email (contains '@').
      if (m.includes("@")) return m;
      return m.replace(/\s+dot\s+/gi, ".");
    }
  );
  return out;
}

/** Hashtags and mentions. */
function formatSocial(input: string): string {
  let out = input.replace(/\bhashtag\s+([A-Za-z0-9_]+)/gi, "#$1");
  out = out.replace(/\bat\s+username\s+([A-Za-z0-9_]+)/gi, "@$1");
  return out;
}

/** Markdown-ish dictation commands. Triggered only at the start of a segment. */
function formatMarkdown(input: string): string {
  const trimmed = input.trimStart();
  const leading = input.slice(0, input.length - trimmed.length);

  const pairs: Array<[RegExp, string]> = [
    [/^heading\s+one[:\-]?\s+/i, "# "],
    [/^heading\s+two[:\-]?\s+/i, "## "],
    [/^heading\s+three[:\-]?\s+/i, "### "],
    [/^heading\s+four[:\-]?\s+/i, "#### "],
    [/^bullet\s+point\s+/i, "- "],
    [/^bullet\s+/i, "- "],
    [/^numbered\s+item\s+/i, "1. "],
    [/^block\s*quote\s+/i, "> "],
  ];

  for (const [re, rep] of pairs) {
    if (re.test(trimmed)) {
      return leading + trimmed.replace(re, rep);
    }
  }

  // Inline wrappers anywhere in the string.
  let out = input;
  out = out.replace(
    /\bbold\s+(.+?)\s+end\s+bold\b/gi,
    (_m, inner: string) => "**" + inner.trim() + "**"
  );
  out = out.replace(
    /\bitalic\s+(.+?)\s+end\s+italic\b/gi,
    (_m, inner: string) => "*" + inner.trim() + "*"
  );
  out = out.replace(
    /\bcode\s+(.+?)\s+end\s+code\b/gi,
    (_m, inner: string) => "`" + inner.trim() + "`"
  );
  return out;
}

export interface SmartFormatOptions {
  emails?: boolean;
  urls?: boolean;
  social?: boolean;
  markdown?: boolean;
  digitRuns?: boolean;
}

const defaultOptions: Required<SmartFormatOptions> = {
  emails: true,
  urls: true,
  social: true,
  markdown: true,
  digitRuns: true,
};

export function applySmartFormat(
  input: string,
  opts: SmartFormatOptions = {}
): string {
  const o = { ...defaultOptions, ...opts };
  if (!input) return input;
  let out = input;
  if (o.markdown) out = formatMarkdown(out);
  if (o.digitRuns) out = collapseDigitRuns(out);
  if (o.emails) out = formatEmails(out);
  if (o.urls) out = formatUrls(out);
  if (o.social) out = formatSocial(out);
  return out;
}
