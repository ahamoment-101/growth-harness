import { keywordLibraryApi } from '../api';
import type { LibraryDetail, LibraryEntryView, LibraryLogPage, LibraryLanguage, LibraryPage, LibraryTopic } from '../../shared/keyword-library';

export type EntryQuery = {
  kind: LibraryEntryView['kind'];
  query?: string;
  parent_id?: string;
  archived?: boolean;
  after?: string;
};
export type LogQuery = { actor_type?: string; target_id?: string; after?: string };

/** The library screens read recorded data through the authenticated host API. */
export type LibrarySource = {
  languages(siteId: string): Promise<{ languages: LibraryLanguage[] }>;
  entries(siteId: string, language: LibraryLanguage, query: EntryQuery): Promise<LibraryPage>;
  detail(siteId: string, language: LibraryLanguage, id: string, after?: string): Promise<LibraryDetail>;
  logs(siteId: string, language: LibraryLanguage, query: LogQuery): Promise<LibraryLogPage>;
  topic(siteId: string, language: LibraryLanguage, id: string, after?: string): Promise<LibraryTopic>;
};

const liveLibrarySource: LibrarySource = {
  languages: (siteId) => keywordLibraryApi.languages(siteId),
  entries: (siteId, language, { kind, query, parent_id, archived, after }) =>
    keywordLibraryApi.entries(siteId, language, { kind, query, parent_id, archived: String(Boolean(archived)), after }),
  detail: (siteId, language, id, after) => keywordLibraryApi.detail(siteId, language, id, after),
  logs: (siteId, language, query) => keywordLibraryApi.logs(siteId, language, query),
  topic: (siteId, language, id, after) => keywordLibraryApi.topic(siteId, language, id, after),
};

/** Development and production use the same persisted library. */
export function librarySource(): LibrarySource {
  return liveLibrarySource;
}
