import { SYSTEM_LANGUAGE, type SystemLanguage } from '../../../shared/system-language';

export type LocaleStrategyBrief = {
  target_locale: string;
  target_language: string;
  target_market: string;
  search_language: string;
  strategy_document_language: SystemLanguage;
  strategy_mode: 'independent_market_strategy';
  evidence_policy: string;
};

function canonicalLocale(value: string): string {
  try {
    return Intl.getCanonicalLocales(value.trim())[0] || value.trim();
  } catch {
    return value.trim();
  }
}

function displayName(type: 'language' | 'region', code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type }).of(code) || code;
  } catch {
    return code;
  }
}

export function localeStrategyBrief(locale: string): LocaleStrategyBrief {
  const targetLocale = canonicalLocale(locale);
  let language = targetLocale.split('-')[0] || targetLocale;
  let region = '';
  try {
    const parsed = new Intl.Locale(targetLocale);
    language = parsed.language || language;
    region = parsed.region || '';
  } catch {
    region = targetLocale.split('-').find((part) => /^[A-Z]{2}$/.test(part)) || '';
  }
  const languageName = displayName('language', language);
  const marketName = region
    ? `${displayName('region', region)} market`
    : `${languageName} language market (no country or region specified)`;
  return {
    target_locale: targetLocale,
    target_language: languageName,
    target_market: marketName,
    search_language: languageName,
    strategy_document_language: SYSTEM_LANGUAGE,
    strategy_mode: 'independent_market_strategy',
    evidence_policy: `Prefer evidence from ${marketName} queries and the corresponding SERPs, using ${languageName}; site-wide or other-market evidence may only serve as clearly labeled cross-market references.`,
  };
}

export function localeStrategyBriefPrompt(brief: LocaleStrategyBrief): string {
  return [
    `Target locale: ${brief.target_locale}`,
    `Target language: ${brief.target_language}`,
    `Target market: ${brief.target_market}`,
    `Search language: ${brief.search_language}`,
    'Strategy mode: research this language market independently; do not translate, copy, or inherit by default from strategies for other languages.',
    `Strategy language: ${brief.strategy_document_language}; keep real queries, SERP phrasing, and market expressions in the original language of the target market.`,
    // Linguistic correctness is not the same as being local. The same language may use entirely different common phrasing for the same thing in different markets,
    // and people search for the exact word rather than its synonyms, so word-choice habits must be verified down to the word level.
    `Word-choice habits: everyday wording for the same language can differ across markets; keywords must use the phrasing ${brief.target_market} users would actually type. When synonymous expressions compete, use search evidence to determine which is the mainstream form in this market — do not choose words for them based on linguistic intuition.`,
    `Evidence rules: ${brief.evidence_policy}`,
  ].join('\n');
}
