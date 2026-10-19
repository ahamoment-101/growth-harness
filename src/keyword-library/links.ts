import { libraryQuery } from '../api';
import type { LibraryLanguage } from '../../shared/keyword-library';
import { sitePage } from '../nav';

export const libraryHref = (siteId: string, language: LibraryLanguage) => `${sitePage(siteId, 'keywords')}?${libraryQuery(language)}`;

export const topicHref = (siteId: string, language: LibraryLanguage, topicId: string) =>
  `${sitePage(siteId, 'keywords')}/topics/${encodeURIComponent(topicId)}?${libraryQuery(language)}`;
