/**
 * Markdown → typed AST, safe by construction.
 *
 * Report text arrives from an untrusted upstream, so it is never turned into an
 * HTML string and never passed to `dangerouslySetInnerHTML`. Instead it is
 * tokenized here into a small closed set of nodes that the React renderer maps
 * to elements. Raw HTML, script/style content, `javascript:`/`data:` URLs and
 * unsafe embeds have no representation in this AST and therefore cannot render.
 */
import { marked, type Tokens, type Token } from "marked";
import { safeHref, stripUnsafeChars, neutralizeMarkup } from "@/lib/security/text";

export { safeHref };

const stripControl = (v: unknown) => stripUnsafeChars(v);

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 2 | 3 | 4; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "quote"; c: Block[] }
  | { t: "pre"; v: string }
  | { t: "hr" };

const MAX_BLOCKS = 400;
const MAX_TEXT = 5000;


function inlineFrom(tokens: Token[] | undefined, depth = 0): Inline[] {
  if (!tokens || depth > 6) return [];
  const out: Inline[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) out.push(...inlineFrom(t.tokens, depth + 1));
        else out.push({ t: "text", v: stripControl(t.text).slice(0, MAX_TEXT) });
        break;
      }
      case "escape":
        out.push({ t: "text", v: stripControl((tok as Tokens.Escape).text) });
        break;
      case "strong":
        out.push({ t: "strong", c: inlineFrom((tok as Tokens.Strong).tokens, depth + 1) });
        break;
      case "em":
        out.push({ t: "em", c: inlineFrom((tok as Tokens.Em).tokens, depth + 1) });
        break;
      case "del":
        // Rendered as plain emphasis; no separate node needed.
        out.push({ t: "em", c: inlineFrom((tok as Tokens.Del).tokens, depth + 1) });
        break;
      case "codespan":
        out.push({ t: "code", v: stripControl((tok as Tokens.Codespan).text).slice(0, 500) });
        break;
      case "br":
        out.push({ t: "br" });
        break;
      case "link": {
        const l = tok as Tokens.Link;
        const href = safeHref(l.href);
        const children = inlineFrom(l.tokens, depth + 1);
        if (href) out.push({ t: "link", href, c: children.length ? children : [{ t: "text", v: href }] });
        else out.push(...(children.length ? children : [{ t: "text", v: stripControl(l.text) } as Inline]));
        break;
      }
      case "image": {
        // Remote images are not embedded. The alt text is kept as prose.
        const im = tok as Tokens.Image;
        const alt = stripControl(im.text || im.title || "image");
        if (alt) out.push({ t: "text", v: alt });
        break;
      }
      case "html":
        // Raw HTML is dropped entirely, tags and all.
        break;
      default: {
        const anyTok = tok as { raw?: string; text?: string };
        const fallback = stripControl(anyTok.text ?? "");
        if (fallback) out.push({ t: "text", v: fallback.slice(0, MAX_TEXT) });
        break;
      }
    }
  }
  return out;
}

function blocksFrom(tokens: Token[], depth = 0): Block[] {
  const out: Block[] = [];
  if (depth > 4) return out;
  for (const tok of tokens) {
    if (out.length >= MAX_BLOCKS) break;
    switch (tok.type) {
      case "paragraph": {
        const c = inlineFrom((tok as Tokens.Paragraph).tokens, depth);
        if (c.length) out.push({ t: "p", c });
        break;
      }
      case "heading": {
        const h = tok as Tokens.Heading;
        // Headings are clamped to h2-h4 so report content can never outrank the
        // page's own document outline.
        const level = (h.depth <= 2 ? 2 : h.depth === 3 ? 3 : 4) as 2 | 3 | 4;
        out.push({ t: "h", level, c: inlineFrom(h.tokens, depth) });
        break;
      }
      case "list": {
        const l = tok as Tokens.List;
        const items = l.items.slice(0, 100).map((it) => inlineFrom(it.tokens, depth + 1));
        out.push({ t: l.ordered ? "ol" : "ul", items });
        break;
      }
      case "blockquote":
        out.push({ t: "quote", c: blocksFrom((tok as Tokens.Blockquote).tokens, depth + 1) });
        break;
      case "code":
        out.push({ t: "pre", v: stripControl((tok as Tokens.Code).text).slice(0, 4000) });
        break;
      case "hr":
        out.push({ t: "hr" });
        break;
      case "space":
      case "html":
        break;
      case "table": {
        // Tables are flattened to paragraphs rather than adding a node type.
        const tb = tok as Tokens.Table;
        for (const row of tb.rows.slice(0, 50)) {
          const c = row.flatMap((cell, i) => {
            const parts = inlineFrom(cell.tokens, depth + 1);
            return i === 0 ? parts : [{ t: "text", v: " — " } as Inline, ...parts];
          });
          if (c.length) out.push({ t: "p", c });
        }
        break;
      }
      default: {
        const anyTok = tok as { text?: string };
        if (anyTok.text) out.push({ t: "p", c: [{ t: "text", v: stripControl(anyTok.text).slice(0, MAX_TEXT) }] });
        break;
      }
    }
  }
  return out;
}

/** Parses untrusted markdown into the safe block AST. */
export function parseSafeMarkdown(input: string): Block[] {
  // Markup is removed before lexing, so a script body can never survive as a
  // text node and malformed tags cannot reach the renderer as prose.
  const source = neutralizeMarkup(String(input ?? "").slice(0, 200_000));
  if (!source.trim()) return [];
  let tokens: Token[];
  try {
    tokens = marked.lexer(source, { gfm: true, breaks: false });
  } catch {
    return [{ t: "p", c: [{ t: "text", v: stripControl(source).slice(0, MAX_TEXT) }] }];
  }
  return blocksFrom(tokens);
}

/** Flattens the AST back to plain text (used for the "copy report" payload). */
export function blocksToPlainText(blocks: Block[]): string {
  const inline = (nodes: Inline[]): string =>
    nodes
      .map((n) => {
        switch (n.t) {
          case "text":
            return n.v;
          case "code":
            return n.v;
          case "br":
            return "\n";
          case "link":
            return `${inline(n.c)} (${n.href})`;
          default:
            return inline(n.c);
        }
      })
      .join("");

  return blocks
    .map((b) => {
      switch (b.t) {
        case "p":
          return inline(b.c);
        case "h":
          return `${"#".repeat(b.level)} ${inline(b.c)}`;
        case "ul":
          return b.items.map((i) => `- ${inline(i)}`).join("\n");
        case "ol":
          return b.items.map((i, idx) => `${idx + 1}. ${inline(i)}`).join("\n");
        case "quote":
          return blocksToPlainText(b.c)
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
        case "pre":
          return b.v;
        case "hr":
          return "---";
      }
    })
    .join("\n\n");
}
