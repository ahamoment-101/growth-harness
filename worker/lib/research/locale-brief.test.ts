import { expect, it } from 'vitest';
import { SYSTEM_LANGUAGE } from '../../../shared/system-language';
import { localeStrategyBrief, localeStrategyBriefPrompt } from './locale-brief';

it('uses English operational reports while preserving a Chinese target market', () => {
  expect(SYSTEM_LANGUAGE).toBe('en');
  expect(localeStrategyBrief('zh-CN')).toMatchObject({
    target_locale: 'zh-CN',
    target_language: 'Chinese',
    search_language: 'Chinese',
    target_market: 'China market',
    strategy_document_language: 'en',
  });
});

it.each(['en-US', 'pt-BR', 'zh-CN'])('keeps system report language separate from the %s market', locale => {
  const brief = localeStrategyBrief(locale);
  expect(brief.target_locale).toBe(locale);
  expect(brief.strategy_document_language).toBe(SYSTEM_LANGUAGE);
  expect(localeStrategyBriefPrompt(brief)).toContain(`Strategy language: ${SYSTEM_LANGUAGE}`);
  expect(localeStrategyBriefPrompt(brief)).toContain('market expressions in the original language of the target market');
});
