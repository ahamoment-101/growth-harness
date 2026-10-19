/** Single supported system language; shared by the console and unattended tasks. */
export const SYSTEM_LANGUAGE_OPTIONS = [{ value: 'en', label: 'English' }] as const;
export type SystemLanguage = typeof SYSTEM_LANGUAGE_OPTIONS[number]['value'];
export const SYSTEM_LANGUAGE: SystemLanguage = SYSTEM_LANGUAGE_OPTIONS[0].value;
export const SYSTEM_LANGUAGE_INSTRUCTIONS = `Write user-facing replies, work updates, review explanations and operational reports in the system language ${SYSTEM_LANGUAGE} (English). Article bodies, market research terms and exact source quotations keep their assigned language. This does not change a site's content locales.`;
