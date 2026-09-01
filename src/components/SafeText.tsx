/**
 * Renders untrusted report text.
 *
 * The markdown AST is mapped to React elements one node at a time. There is no
 * HTML string anywhere on this path, so injected markup, scripts, event
 * handlers and `javascript:`/`data:` URLs cannot execute — they were already
 * dropped at parse time, and React escapes whatever text remains.
 */
import { Fragment, type ReactNode } from "react";
import { parseSafeMarkdown, type Block, type Inline } from "@/lib/report/safe-markdown";

function renderInline(nodes: Inline[], keyPrefix = "i"): ReactNode {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.t) {
      case "text":
        return <Fragment key={key}>{node.v}</Fragment>;
      case "strong":
        return (
          <strong key={key} className="font-semibold text-ink">
            {renderInline(node.c, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(node.c, key)}</em>;
      case "code":
        return <code key={key}>{node.v}</code>;
      case "br":
        return <br key={key} />;
      case "link":
        // `href` was validated to be http(s) during parsing.
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {renderInline(node.c, key)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: Block[], keyPrefix = "b"): ReactNode {
  return blocks.map((block, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (block.t) {
      case "p":
        return <p key={key}>{renderInline(block.c, key)}</p>;
      case "h": {
        const Tag = (`h${block.level}` as const) satisfies "h2" | "h3" | "h4";
        return <Tag key={key}>{renderInline(block.c, key)}</Tag>;
      }
      case "ul":
        return (
          <ul key={key}>
            {block.items.map((item, j) => (
              <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol key={key}>
            {block.items.map((item, j) => (
              <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
            ))}
          </ol>
        );
      case "quote":
        return <blockquote key={key}>{renderBlocks(block.c, key)}</blockquote>;
      case "pre":
        return (
          <pre key={key}>
            <code>{block.v}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} className="border-line" />;
    }
  });
}

/** Untrusted markdown, rendered safely. */
export function SafeMarkdown({ children, className }: { children: string; className?: string }) {
  const blocks = parseSafeMarkdown(children);
  if (blocks.length === 0) return null;
  return <div className={className ?? "prose-terminal"}>{renderBlocks(blocks)}</div>;
}

/**
 * Untrusted plain text. Markdown is not interpreted; the string is rendered as
 * a text node, which React escapes.
 */
export function SafeText({ children }: { children: string }) {
  return <>{children}</>;
}
