/** Renderer capabilities, shared by authoring validation and model context. */
export const ARTICLE_MARKDOWN_CAPABILITIES = 'Markdown supports headings ## through ######, paragraphs, nested lists, fenced code blocks, horizontal rules, pipe tables, blockquotes, emphasis, links, and images using public HTTP(S) URLs. The page supplies the H1. Headings receive stable anchors. Raw HTML is displayed as text.';

export type ArticlePresentation = {
  meta_description?: string;
  image_url?: string;
  image_alt?: string;
};

export function publicHttpUrl(value: unknown, base?: string): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = base ? new URL(value.trim(), base) : new URL(value.trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** Empty fields explicitly clear a value; omitted fields leave existing metadata alone. */
export function articlePresentationPatch(input: Record<string, unknown>): ArticlePresentation {
  const out: ArticlePresentation = {};
  for (const field of ['meta_description', 'image_url', 'image_alt'] as const) {
    if (!(field in input)) continue;
    if (typeof input[field] !== 'string') throw new Error(`${field} must be text`);
    out[field] = input[field].trim();
  }
  if (out.image_url && !publicHttpUrl(out.image_url)) throw new Error('image_url must be a public HTTP(S) URL');
  return out;
}
