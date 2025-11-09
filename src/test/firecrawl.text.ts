import { htmlToText } from "html-to-text";

export function stripHtml(html: string) {
  // Use industry-standard HTML -> text conversion; collapse whitespace for consistency
  const text = htmlToText(html, {
    wordwrap: false,
    // html-to-text already skips <script> and <style> by default
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
    ],
  });
  return text.replace(/\s+/g, " ").trim();
}

export function chunkText(s: string, size = 800) {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}
