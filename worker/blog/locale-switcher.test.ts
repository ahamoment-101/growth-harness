import { describe, expect, it } from 'vitest';
import { localeDisplayName, localeSwitcherCss, localeSwitcherHtml } from './locale-switcher';

describe('locale switcher html', () => {
  it('renders a hoverable menu with crawlable blog locale links and nothing when only one locale exists', () => {
    const html = localeSwitcherHtml([
      { locale: 'en', href: 'https://blog.example.com/en/blog' },
      { locale: 'zh-CN', href: 'https://blog.example.com/zh/blog' },
    ], 'zh-CN');
    expect(html).toContain('class="bs-locale-switcher"');
    expect(html).toContain('class="bs-locale-trigger"');
    expect(html).toContain('class="bs-locale-panel" role="menu"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('https://blog.example.com/en/blog?set_locale=en');
    expect(html).toContain('https://blog.example.com/zh/blog?set_locale=zh-CN');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(localeDisplayName('zh-CN'));
    expect(localeSwitcherHtml([{ locale: 'en', href: '/en/blog' }], 'en')).toBe('');
  });

  it('keeps hover active through the menu gap and rotates the chevron around its center', () => {
    expect(localeSwitcherCss).toContain('.bs-locale-dropdown::after');
    expect(localeSwitcherCss).toContain('height: 8px');
    expect(localeSwitcherCss).toContain('transform-origin: center');
    expect(localeSwitcherCss).toContain('transform: rotate(180deg);');
    expect(localeSwitcherCss).not.toContain('position: sticky');
    expect(localeSwitcherCss).not.toContain('position: fixed');
    expect(localeSwitcherCss).not.toContain('position: absolute; top: 16px');
    expect(localeSwitcherCss).toContain('align-items: center;');
  });

  it('draws the chevron as an svg so it centers vertically against the label', () => {
    const html = localeSwitcherHtml([
      { locale: 'en', href: 'https://blog.example.com/en/blog' },
      { locale: 'zh-CN', href: 'https://blog.example.com/zh/blog' },
    ], 'en');
    // A text glyph ("⌄") sits wherever the font's baseline puts it and reads off-center.
    expect(html).not.toContain('⌄');
    expect(html).toContain('<span class="bs-locale-chevron" aria-hidden="true"><svg');
    expect(localeSwitcherCss).toContain('.bs-locale-chevron { display: inline-flex;');
  });
});
