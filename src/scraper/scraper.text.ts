import { htmlToText } from "html-to-text";

export function stripHtml(html: string) {
  // Robust HTML -> text with nav/header/footer/etc skipped and link hrefs suppressed
  const text = htmlToText(html, {
    wordwrap: false,
    baseElements: {
      selectors: ["main", "article", "[role=main]", "#main"],
      orderBy: "occurrence",
      returnDomByDefault: true,
    },
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "header", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "aside", format: "skip" },
      { selector: "form", format: "skip" },
      { selector: "button", format: "skip" },
      { selector: "svg", format: "skip" },
      // Suppress noisy URL brackets in link text
      { selector: "a", options: { ignoreHref: true, hideLinkHrefIfSameAsText: true } },
    ],
  });
  return text.replace(/\s+/g, " ").trim();
}

export function chunkText(s: string, size = 800) {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}
