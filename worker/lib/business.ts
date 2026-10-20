import {
  BUSINESS_MODULES,
  businessModuleMarkdown,
  contentFromBusinessMarkdown,
  emptyBusinessModuleContent,
  isBusinessModuleKey,
  normalizeBusinessModuleContent,
  type BusinessModuleContent,
  type BusinessModuleKey,
} from '../../shared/business';
import { isoNow, newId } from '../db';

export type BusinessModuleVersion = {
  id: string;
  site_id: string;
  module_key: string;
  version: number;
  schema_version: number;
  content_json: string;
  markdown: string;
  source: string;
  created_at: string;
};

export type BusinessModuleView = {
  key: BusinessModuleKey;
  content: BusinessModuleContent;
  markdown: string;
  version: number;
  schema_version: number;
  source: string;
  updated_at: string;
};

export async function listBusinessModules(db: D1Database, siteId: string): Promise<BusinessModuleView[]> {
  const { results } = await db
    .prepare('select * from business_module_versions where site_id = ? order by module_key asc, version desc')
    .bind(siteId)
    .all<BusinessModuleVersion>();
  const latest = new Map<BusinessModuleKey, BusinessModuleVersion>();
  for (const row of results ?? []) {
    if (!isBusinessModuleKey(row.module_key) || latest.has(row.module_key)) continue;
    latest.set(row.module_key, row);
  }
  return BUSINESS_MODULES.map((definition) => publicBusinessModule(definition.key, latest.get(definition.key)));
}

export async function saveBusinessModule(
  db: D1Database,
  siteId: string,
  key: BusinessModuleKey,
  markdown: string,
  source = 'manual',
): Promise<BusinessModuleView> {
  const normalizedMarkdown = String(markdown || '').trim();
  const normalized = normalizedMarkdown ? contentFromBusinessMarkdown(key, normalizedMarkdown) : normalizeBusinessModuleContent(key, {});
  const contentJson = JSON.stringify(normalized);
  const current = await latestBusinessModule(db, siteId, key);
  if (current?.content_json === contentJson && current.markdown === normalizedMarkdown) return publicBusinessModule(key, current);
  const row: BusinessModuleVersion = {
    id: newId(),
    site_id: siteId,
    module_key: key,
    version: Number(current?.version || 0) + 1,
    schema_version: 1,
    content_json: contentJson,
    markdown: normalizedMarkdown,
    source,
    created_at: isoNow(),
  };
  await db
    .prepare(
      `insert into business_module_versions
       (id, site_id, module_key, version, schema_version, content_json, markdown, source, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.site_id, row.module_key, row.version, row.schema_version, row.content_json, row.markdown, row.source, row.created_at)
    .run();
  return publicBusinessModule(key, row);
}

export function buildBusinessContext(modules: BusinessModuleView[]): string {
  const sections = modules
    .map((module) => {
      // Markdown is the editable document; parsed fields are a compatibility view,
      // not a requirement that users preserve the template's exact headings.
      const markdown = module.markdown.trim();
      const visible = (value: string) => value.replace(/<!--[\s\S]*?-->/g, '').trim().replace(/\s+/g, ' ');
      const emptyTemplate = businessModuleMarkdown(module.key, {});
      if (visible(markdown) && visible(markdown) !== visible(emptyTemplate)) return markdown;
      return Object.values(module.content).some((value) => value.trim())
        ? businessModuleMarkdown(module.key, module.content) : '';
    })
    .filter(Boolean);
  if (!sections.length) {
    return 'No manually confirmed business information is available. Do not invent product claims, pricing, customers, or differentiators.';
  }
  return sections.join('\n\n---\n\n');
}

async function latestBusinessModule(
  db: D1Database,
  siteId: string,
  key: BusinessModuleKey,
): Promise<BusinessModuleVersion | null> {
  return db
    .prepare('select * from business_module_versions where site_id = ? and module_key = ? order by version desc limit 1')
    .bind(siteId, key)
    .first<BusinessModuleVersion>();
}

function publicBusinessModule(key: BusinessModuleKey, row?: BusinessModuleVersion): BusinessModuleView {
  let content = emptyBusinessModuleContent(key);
  if (row?.content_json) {
    try {
      content = normalizeBusinessModuleContent(key, JSON.parse(row.content_json));
    } catch {
      content = emptyBusinessModuleContent(key);
    }
  }
  return {
    key,
    content,
    markdown: row?.markdown || businessModuleMarkdown(key, content),
    version: Number(row?.version || 0),
    schema_version: Number(row?.schema_version || 1),
    source: row?.source || '',
    updated_at: row?.created_at || '',
  };
}
