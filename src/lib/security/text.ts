/**
 * Text hardening primitives shared by the report schema and the markdown parser.
 *
 * Implemented with numeric code-point checks rather than regex escapes so the
 * source file stays pure ASCII and the ranges are auditable at a glance.
 */

/** True for characters that must never survive into rendered report content. */
export function isUnsafeCodePoint(code: number, allowNewlines: boolean): boolean {
  // C0 controls. Tab (9), LF (10) and CR (13) are conditionally allowed.
  if (code < 0x20) {
    if (allowNewlines && (code === 9 || code === 10 || code === 13)) return false;
    return true;
  }
  // DEL + C1 controls.
  if (code >= 0x7f && code <= 0x9f) return true;
  // Zero-width space/non-joiner/joiner and LTR/RTL marks.
  if (code >= 0x200b && code <= 0x200f) return true;
  // Bidi embedding/override controls (used to visually spoof text).
  if (code >= 0x202a && code <= 0x202e) return true;
  // Bidi isolates.
  if (code >= 0x2066 && code <= 0x2069) return true;
  // Byte-order mark / zero-width no-break space.
  if (code === 0xfeff) return true;
  return false;
}

/** Removes control, bidi and zero-width characters from untrusted text. */
export function stripUnsafeChars(input: unknown, allowNewlines = true): string {
  const s = typeof input === "string" ? input : String(input ?? "");
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (isUnsafeCodePoint(code, allowNewlines)) continue;
    out += ch;
  }
  return out;
}

/**
 * Removes formatting debris that should never be visible in report copy.
 *
 * Matched Markdown is handled by the safe Markdown parser. This fallback also
 * catches incomplete emphasis from upstream responses, such as `**$1.5M`, and
 * repeated quote markers while preserving apostrophes in words like `it's`.
 */
export function cleanVisibleText(input: unknown): string {
  return stripUnsafeChars(input)
    .replace(/\*+/g, "")
    .replace(/[\u201c\u201d"]/g, "")
    .replace(/'{2,}/g, "")
    .replace(/[\u2018\u2019]{2,}/g, "");
}


/**
 * Elements whose *contents* are removed along with the tags. Leaving the body
 * behind would render a script's source as visible prose.
 */
const DANGEROUS_ELEMENTS =
  /<\s*(script|style|iframe|object|embed|template|noscript|svg|math|link|meta|base|form)\b[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi;

/**
 * Any remaining tag-like sequence: `<` followed by a letter, `/` or `!`, up to
 * the next `>`. This also catches malformed constructs such as
 * `<svg/onload=alert(1)>` that a markdown lexer does not classify as HTML.
 */
const TAG_LIKE = /<[a-zA-Z!/][^>]*>?/g;

/**
 * Removes HTML markup from untrusted text.
 *
 * Report content is never rendered as HTML, so markup has no legitimate
 * meaning here. Stripping it keeps injected tags from appearing as prose and
 * removes any chance of a downstream consumer re-interpreting them.
 */
export function neutralizeMarkup(input: unknown): string {
  const s = typeof input === "string" ? input : String(input ?? "");
  return s.replace(DANGEROUS_ELEMENTS, " ").replace(TAG_LIKE, "");
}

/**
 * True when a URL string contains characters that could smuggle a different
 * scheme past `new URL()` (whitespace, angle brackets, quotes, backslashes).
 */
export function hasUrlSmugglingChars(href: string): boolean {
  for (const ch of href) {
    const code = ch.codePointAt(0);
    if (code === undefined) return true;
    if (code <= 0x20) return true;
    if (ch === "<" || ch === ">" || ch === '"' || ch === "'" || ch === "`" || ch === "\\") return true;
  }
  return false;
}

/**
 * Only `http:` and `https:` URLs are allowed anywhere in report output.
 * Returns the normalized URL, or null if it must not be rendered as a link.
 */
export function safeHref(raw: unknown): string | null {
  const href = typeof raw === "string" ? raw.trim() : "";
  if (!href) return null;
  if (hasUrlSmugglingChars(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
