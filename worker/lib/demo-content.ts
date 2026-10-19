import type { ArticleVersion } from '../types';

/** Explicit synthetic layout/export sample; contains no customer claims or real production references. */
export function seededVersions(locales: string[], hubPath: string): ArticleVersion[] {
  const primary = locales[0] || 'en';
  return locales.map(locale => ({
    locale,
    slug: locale === primary ? 'example-help-documentation' : `example-help-documentation-${locale.toLowerCase()}`,
    title: 'Example: Organizing help documentation',
    excerpt: 'Synthetic installation sample for layout and export checks. Replace before publishing.',
    content: [
      'This is synthetic installation material. It does not describe a real product, customer, research result or business outcome. Language variants repeat this sample for layout checks; they are not translations.',
      '',
      '## Start from a reader question',
      '',
      'Choose a question that a reader needs answered. Record what information is available and which facts still need confirmation. Keep observations separate from assumptions.',
      '',
      '## Review the draft',
      '',
      'Check whether the steps can be followed, whether links have useful labels, and whether the article states its limitations. Confirm product capabilities with the responsible person before making public claims.',
      '',
      `Use the [help documentation hub](${hubPath || '/help'}) to find related material. This sample link tests the configured hub path.`,
      '',
      '## Prepare a real publication',
      '',
      'Replace this sample with verified source material and the actual reader task. Request human review through the normal publication process. A successful installation check only confirms the tested technical path.',
    ].join('\n'),
  }));
}
