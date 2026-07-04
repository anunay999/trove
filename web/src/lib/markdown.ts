import DOMPurify from "dompurify";
import { marked } from "marked";

// Imported summaries carry raw markdown; render them as clean prose.
export function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias ?? target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// Render a vault document the way Obsidian would: frontmatter stripped,
// wikilinks flattened to their labels, markdown to sanitized HTML.
export function renderDocument(markdown: string): string {
  const withoutFrontmatter = markdown.startsWith("---\n")
    ? markdown.slice(markdown.indexOf("\n---", 4) + 4)
    : markdown;
  const withLinks = withoutFrontmatter.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target, alias) => alias ?? target,
  );
  const html = marked.parse(withLinks, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
