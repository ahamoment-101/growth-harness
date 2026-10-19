import { SLUG_RE } from './qa';
import { markdownSubsetIssues } from './qa';
import { articlePresentationPatch, type ArticlePresentation } from '../../shared/article-presentation';

export type ImportedArticle = ArticlePresentation & {
  locale: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  category: string;
};

/**
 * Normalize and validate a manually imported article payload.
 * Mechanical checks only: required fields, slug shape, and length caps.
 * Reader-value judgments stay with the human who is importing the article.
 */
export function normalizeImportArticle(body: Record<string, unknown>): ImportedArticle {
  const locale = str(body.locale);
  const title = str(body.title);
  const slug = str(body.slug).toLowerCase();
  const excerpt = str(body.excerpt);
  const content = str(body.content);
  const category = str(body.category);

  if (!locale) throw new Error('locale is required');
  if (locale.length > 20) throw new Error('locale is too long');
  if (!title) throw new Error('title, slug and content are required');
  if (!slug) throw new Error('title, slug and content are required');
  if (!content) throw new Error('title, slug and content are required');
  if (!SLUG_RE.test(slug)) throw new Error('slug must be lowercase kebab-case');
  if (title.length > 500) throw new Error('title is too long');
  if (excerpt.length > 2000) throw new Error('excerpt is too long');
  if (category.length > 100) throw new Error('category is too long');

  const issues = markdownSubsetIssues(locale, content);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('; '));
  return { locale, title, slug, excerpt, content, category, ...articlePresentationPatch(body) };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
