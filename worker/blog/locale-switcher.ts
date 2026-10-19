export const LOCALE_PREFERENCE_PARAM = 'set_locale';

export type LocaleNavLink = { locale: string; href: string };

export function localeDisplayName(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return code;
  try {
    const native = new Intl.DisplayNames([trimmed], { type: 'language' }).of(trimmed);
    if (native) return native;
  } catch { /* fall through */ }
  try {
    const english = new Intl.DisplayNames(['en'], { type: 'language' }).of(trimmed);
    if (english) return english;
  } catch { /* fall through */ }
  return trimmed;
}

export function localeSwitcherHtml(links: LocaleNavLink[], current: string): string {
  if (links.length <= 1) return '';
  const active = links.find((item) => item.locale === current) || links[0];
  const items = links.map((item) => {
    const currentLocale = item.locale === current;
    const attrs = currentLocale ? ' class="bs-locale-current" aria-current="true"' : '';
    return `<a href="${esc(localePreferenceHref(item.href, item.locale))}"${attrs} role="menuitem">${esc(localeDisplayName(item.locale))}</a>`;
  }).join('');
  const currentName = localeDisplayName(active.locale);
  return `<div class="bs-locale-switcher" role="group" aria-label="Languages"><div class="bs-locale-dropdown">
<button class="bs-locale-trigger" type="button" aria-haspopup="menu" aria-label="Change language. Current: ${esc(currentName)}">${esc(currentName)}${CHEVRON_SVG}</button>
<div class="bs-locale-panel" role="menu">${items}</div>
</div></div>`;
}

// A text glyph ("⌄") sits wherever the font's baseline puts it, which reads off-center against the
// label; an SVG chevron is geometrically centered inside the flex trigger instead.
const CHEVRON_SVG = '<span class="bs-locale-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 6 3.5 4 3.5-4"/></svg></span>';

function localePreferenceHref(href: string, locale: string): string {
  try {
    const url = new URL(href);
    url.searchParams.set(LOCALE_PREFERENCE_PARAM, locale);
    return url.toString();
  } catch {
    const separator = href.includes('?') ? '&' : '?';
    return `${href}${separator}${LOCALE_PREFERENCE_PARAM}=${encodeURIComponent(locale)}`;
  }
}

export const localeSwitcherCss = `
  .bs-locale-switcher { display: inline-block; color: inherit; font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: .01em; }
  .bs-locale-dropdown { position: relative; }
  .bs-locale-dropdown::after { content: ''; position: absolute; top: 100%; right: 0; width: 100%; height: 8px; }
  .bs-locale-trigger { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin: 0; padding: 6px 10px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 999px; background: color-mix(in srgb, #fff 82%, transparent); color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; }
  .bs-locale-trigger:hover, .bs-locale-dropdown:focus-within .bs-locale-trigger { border-color: color-mix(in srgb, currentColor 34%, transparent); background: #fff; }
  .bs-locale-trigger:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 55%, transparent); outline-offset: 2px; }
  .bs-locale-chevron { display: inline-flex; transform-origin: center; transition: transform 120ms ease; }
  .bs-locale-chevron svg { display: block; width: 10px; height: 10px; }
  .bs-locale-dropdown:hover .bs-locale-chevron, .bs-locale-dropdown:focus-within .bs-locale-chevron { transform: rotate(180deg); }
  .bs-locale-panel { position: absolute; top: calc(100% + 8px); right: 0; z-index: 30; display: none; min-width: max-content; padding: 4px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; background: #fff; box-shadow: 0 12px 28px rgba(16, 20, 38, .14); }
  .bs-locale-dropdown:hover .bs-locale-panel, .bs-locale-dropdown:focus-within .bs-locale-panel { display: flex; flex-direction: column; }
  .bs-locale-panel a { display: block; padding: 8px 10px; border-radius: 8px; color: inherit; text-decoration: none; white-space: nowrap; opacity: .76; }
  .bs-locale-panel a:hover, .bs-locale-panel a:focus-visible { background: color-mix(in srgb, currentColor 9%, transparent); opacity: 1; outline: none; }
  .bs-locale-panel .bs-locale-current { font-weight: 700; opacity: 1; }
`;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] || char);
}
