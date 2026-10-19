export const BUSINESS_MODULES = [
  {
    key: 'product',
    page: 'product',
    label: 'Product Information',
    eyebrow: 'PRODUCT',
    description: 'Define what the product is, what problem it solves, and the capabilities that the content can express accurately.',
    consumers: ['Strategist', 'Topic research', 'Content creation', 'Quality check and publishing'],
    fields: [
      { key: 'summary', label: 'One-sentence introduction', help: 'State in one sentence for whom the product solves what problem.', placeholder: 'For example: helping cross-border teams quickly localize product content into multiple languages.', rows: 2 },
      { key: 'category', label: 'Product categories', help: 'What users would call this type of product.', placeholder: 'For example: AI localization platform, team knowledge base.', rows: 2 },
      { key: 'offerings', label: 'Products and services', help: 'Main product lines, plans, or service offerings, one per line.', placeholder: 'Core product\nValue-added services\nEnterprise solutions', rows: 5 },
      { key: 'capabilities', label: 'Core capabilities', help: 'Real capabilities that can be referenced in content and marketing materials.', placeholder: 'Capability name: specific description', rows: 6 },
      { key: 'use_cases', label: 'Primary use cases', help: 'In what situations users use the product.', placeholder: 'Scenario, trigger conditions, and expected outcome.', rows: 5 },
      { key: 'differentiators', label: 'Differentiation', help: 'What is genuinely different compared to other options.', placeholder: 'Only fill in differences that can be verified; avoid empty slogans.', rows: 5 },
    ],
  },
  {
    key: 'audience',
    page: 'audience',
    label: 'Target Customers',
    eyebrow: 'AUDIENCE',
    description: 'Clarify the users, buyers, core jobs, pain points, and decision obstacles.',
    consumers: ['Strategist', 'Topic research', 'Content creation'],
    fields: [
      { key: 'primary_audience', label: 'Core customers', help: 'Who the most important users or customers are.', placeholder: 'Roles, industries, team size, regions.', rows: 4 },
      { key: 'segments', label: 'Customer segments', help: 'Different customer groups and their differences, one group per line.', placeholder: 'Customer group: characteristics and value', rows: 5 },
      { key: 'jobs', label: 'Core jobs', help: 'The work and outcomes customers want to accomplish.', placeholder: 'When ..., they want ..., so that ...', rows: 5 },
      { key: 'pain_points', label: 'Pain points and triggers', help: 'The problems that drive customers to seek solutions.', placeholder: 'Problems, consequences, and trigger timing.', rows: 5 },
      { key: 'objections', label: 'Concerns and objections', help: 'The main resistance before purchasing or using.', placeholder: 'Price, migration cost, credibility, learning curve, etc.', rows: 4 },
    ],
  },
  {
    key: 'brand',
    page: 'brand',
    label: 'Brand and Voice',
    eyebrow: 'BRAND',
    description: 'Unified positioning, brand voice, core messages, proof materials, and forbidden expressions.',
    consumers: ['Content creation', 'Quality check and publishing', 'Social Media Operations'],
    fields: [
      { key: 'positioning', label: 'Brand positioning', help: 'What position you want to occupy in target customers\' minds.', placeholder: 'Provide ... for ..., differentiating from ...', rows: 4 },
      { key: 'voice', label: 'Brand voice', help: 'Tone, rhythm, expression style, and personality.', placeholder: 'For example: professional but not bureaucratic, direct, restrained, evidence-driven.', rows: 5 },
      { key: 'key_messages', label: 'Core messages', help: 'The claims that need to be repeatedly established.', placeholder: 'Claim: supporting explanation', rows: 5 },
      { key: 'proof_points', label: 'Proof materials', help: 'Credible evidence such as customers, data, case studies, and credentials.', placeholder: 'Only fill in proof that is real and usable.', rows: 4 },
      { key: 'prohibited_claims', label: 'Forbidden expressions', help: 'Claims that cannot be promised, cannot be used, or are easily misleading.', placeholder: 'Banned words, compliance boundaries, unverifiable promises.', rows: 4 },
    ],
  },
  {
    key: 'competition',
    page: 'competition',
    label: 'Competitive Analysis',
    eyebrow: 'COMPETITION',
    description: 'Record competitors, competitive dimensions, their tactics, and your own strengths and gaps.',
    consumers: ['Strategist', 'Topic research', 'Content creation'],
    fields: [
      { key: 'competitor_set', label: 'Main competitors', help: 'Direct competitors, indirect competitors, and alternatives.', placeholder: 'Domain or name: competitive relationship and reasons', rows: 7 },
      { key: 'competition_dimensions', label: 'Competitive dimensions', help: 'The dimensions along which customers compare and choose.', placeholder: 'Price, features, speed, service, brand, channels, etc.', rows: 5 },
      { key: 'competitor_playbooks', label: 'Competitor tactics', help: 'Competitors\' positioning, marketing, business model, and customer acquisition methods.', placeholder: 'Competitors: positioning / channels / content / business model', rows: 7 },
      { key: 'gaps_and_advantages', label: 'Advantages and market gaps', help: 'Differences that can be leveraged and unmet needs.', placeholder: 'Advantage or gap: evidence and implications', rows: 6 },
    ],
  },
  {
    key: 'marketing',
    page: 'marketing',
    label: 'Marketing Strategy',
    eyebrow: 'MARKETING',
    description: 'Unified channels, content themes, funnel, campaigns, and current strategy direction.',
    consumers: ['Strategist', 'Topic research', 'Content creation', 'Social Media Operations'],
    fields: [
      { key: 'current_strategy', label: 'Current strategy', help: 'The most important growth direction at this stage.', placeholder: 'Goals, core judgments, and execution focus.', rows: 5 },
      { key: 'channels', label: 'Acquisition channels', help: 'Channels currently in use or planned.', placeholder: 'Channels: target users, content formats, current status', rows: 6 },
      { key: 'content_pillars', label: 'Content pillars', help: 'Themes that need long-term awareness building.', placeholder: 'Theme: why it matters, which customer need it serves', rows: 6 },
      { key: 'funnel', label: 'Marketing funnel', help: 'Key steps from awareness to conversion.', placeholder: 'Awareness → Consideration → Conversion → Retention', rows: 5 },
      { key: 'offers', label: 'Campaigns and Offers', help: 'Campaigns, resources, or offers currently being promoted.', placeholder: 'Campaign: goal, entry point, validity period, CTA', rows: 5 },
    ],
  },
  {
    key: 'conversion',
    page: 'conversion',
    label: 'Conversion Goals',
    eyebrow: 'CONVERSION',
    description: 'Clearly define the actions content and marketing should ultimately drive, how they are measured, and their constraints.',
    consumers: ['Strategist', 'Content creation', 'Quality check and publishing'],
    fields: [
      { key: 'primary_conversion', label: 'Primary conversion', help: 'The most important user action.', placeholder: 'Action, entry page, and completion criteria.', rows: 4 },
      { key: 'secondary_conversions', label: 'Secondary conversions', help: 'Intermediate actions such as subscribing, downloading, signing up, or inquiry.', placeholder: 'Action: business significance', rows: 5 },
      { key: 'success_definition', label: 'Success criteria', help: 'How to determine whether content or campaigns produced business results.', placeholder: 'Metrics, observation period, and evaluation method.', rows: 5 },
      { key: 'constraints', label: 'Conversion constraints', help: 'Constraints such as region, pricing, compliance, and delivery capacity.', placeholder: 'Constraints: impact on content and CTAs', rows: 4 },
    ],
  },
] as const;

export type BusinessModuleDefinition = (typeof BUSINESS_MODULES)[number];
export type BusinessModuleKey = BusinessModuleDefinition['key'];
export type BusinessPageKey = BusinessModuleDefinition['page'];
export type BusinessModuleContent = Record<string, string>;

export function isBusinessModuleKey(value: string): value is BusinessModuleKey {
  return BUSINESS_MODULES.some((module) => module.key === value);
}

export function businessModuleByKey(key: string): BusinessModuleDefinition | undefined {
  return BUSINESS_MODULES.find((module) => module.key === key);
}

export function businessModuleByPage(page: string): BusinessModuleDefinition | undefined {
  return BUSINESS_MODULES.find((module) => module.page === page);
}

export function emptyBusinessModuleContent(key: BusinessModuleKey): BusinessModuleContent {
  const module = businessModuleByKey(key);
  return Object.fromEntries((module?.fields ?? []).map((field) => [field.key, '']));
}

export function normalizeBusinessModuleContent(key: BusinessModuleKey, value: unknown): BusinessModuleContent {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const module = businessModuleByKey(key);
  return Object.fromEntries(
    (module?.fields ?? []).map((field) => [field.key, String(input[field.key] ?? '').trim().slice(0, 4000)]),
  );
}

export function businessModuleMarkdown(key: BusinessModuleKey, value: unknown): string {
  const definition = businessModuleByKey(key);
  const content = normalizeBusinessModuleContent(key, value);
  if (!definition) return '';
  return [
    `# ${definition.label}`,
    '',
    definition.description,
    '',
    ...definition.fields.flatMap((field) => [`## ${field.label}`, '', content[field.key] || `<!-- ${field.help} -->`, '']),
  ].join('\n').trim();
}

export function contentFromBusinessMarkdown(key: BusinessModuleKey, markdown: string): BusinessModuleContent {
  const definition = businessModuleByKey(key);
  if (!definition) return {};
  const sections = new Map<string, string>();
  const heading = /^##\s+(.+)\s*$/gm;
  const matches = [...markdown.matchAll(heading)];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index! + matches[index][0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.set(matches[index][1].trim(), markdown.slice(start, end).replace(/<!--[^]*?-->/g, '').trim());
  }
  return Object.fromEntries(definition.fields.map((field) => [field.key, sections.get(field.label) || '']));
}
