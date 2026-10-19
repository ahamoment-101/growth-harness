import { describe, expect, it } from 'vitest';
import type { ArticleVersion, Job } from '../types';
import { jobDetailVersions } from './job-detail';

const source: ArticleVersion = { locale: 'en', title: 'Handoff', slug: 'handoff', excerpt: 'Prepare a handoff', content: 'Original draft.' };
const french: ArticleVersion = { locale: 'fr', title: 'Passation', slug: 'passation', excerpt: 'Préparer une passation', content: 'Le contenu traduit.' };
const job = (status: Job['status'], versions: ArticleVersion[]) => ({ status, versions_json: JSON.stringify(versions) }) as Job;

describe('article detail version ownership', () => {
  it('includes published localizations absent from the original accepted candidate', () => {
    expect(jobDetailVersions(job('published', [source, french]), [source])).toEqual([source, french]);
  });

  it('reads a saved owner edit instead of reverting to the accepted snapshot', () => {
    const edited = { ...source, excerpt: 'Updated owner summary', content: 'Corrected published body.' };
    expect(jobDetailVersions(job('published', [edited]), [source])).toEqual([edited]);
  });

  it('previews the latest candidate while the manuscript is still under review', () => {
    const revised = { ...source, content: 'Revised candidate awaiting review.' };
    expect(jobDetailVersions(job('drafting', [source]), [revised])).toEqual([revised]);
    expect(jobDetailVersions(job('awaiting_review', [source]), [revised])).toEqual([revised]);
  });

  it('reads imported or legacy job content when there is no candidate', () => {
    expect(jobDetailVersions(job('published', [source]), [])).toEqual([source]);
    expect(jobDetailVersions(job('drafting', [source]), [])).toEqual([source]);
  });

  it('keeps the assigned source language first after selecting the live versions', () => {
    expect(jobDetailVersions(job('published', [source, french]), [source], ['fr', 'en'])).toEqual([french, source]);
  });
});
