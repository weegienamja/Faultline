// Fetches the application stylesheet as the browser would assemble it.
//
// The stylesheet is an entry file that assigns each part to a cascade layer via
// `@import ... layer(name)`. A test that asserts a particular rule ships to the
// browser therefore has to follow those imports, or it is really asserting
// which file the rule happens to live in — which is an implementation detail
// that changes whenever the layers are reorganised.

const IMPORT = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g;

/**
 * Returns the concatenated text of the entry stylesheet and everything it
 * imports, so `css.includes(".fl-analyst")` means "this rule reaches the
 * browser" rather than "this rule is in the file I guessed".
 */
export async function fetchStylesheet(base, entry = "/css/faultline.css") {
  const response = await fetch(`${base}${entry}`);
  if (!response.ok) throw new Error(`Stylesheet ${entry} returned HTTP ${response.status}`);
  const root = await response.text();

  const directory = entry.slice(0, entry.lastIndexOf("/") + 1);
  const parts = [root];
  for (const [, href] of root.matchAll(IMPORT)) {
    const path = href.startsWith("/") ? href : `${directory}${href.replace(/^\.\//, "")}`;
    const part = await fetch(`${base}${path}`);
    if (!part.ok) throw new Error(`Imported stylesheet ${path} returned HTTP ${part.status}`);
    parts.push(await part.text());
  }
  return parts.join("\n");
}
