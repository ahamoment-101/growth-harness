import type { ArticleVersion, Job } from '../types';
import { jobVersions, orderVersions } from './versions';

/** Candidates are review snapshots; published details reflect the current live versions. */
export function jobDetailVersions(job: Job, candidateVersions: ArticleVersion[], locales: string[] = []): ArticleVersion[] {
  const versions = job.status !== 'published' && candidateVersions.length ? candidateVersions : jobVersions(job);
  return orderVersions(versions, locales);
}
