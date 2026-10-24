/** Exact references supplied by domain tools after scoped object validation.
 * An empty list means no object attribution is known, not an invented object.
 * A version is an immutable domain revision reference (for example an artifact).
 */
export type TaskSubject = { type: string; id: string; version: string | null };
export function taskSubjectsJson(subjects?: TaskSubject[]): string | null {
  if (subjects === undefined) return null; // inherit the task's existing scope
  const keys = new Set<string>();
  for (const s of subjects) {
    if (typeof s.type !== 'string' || !s.type || typeof s.id !== 'string' || !s.id || (s.version !== null && (typeof s.version !== 'string' || !s.version))) throw new Error('Subject references must be exact non-empty identities');
    const key = JSON.stringify([s.type, s.id, s.version]);
    if (keys.has(key)) throw new Error('Duplicate subject reference');
    keys.add(key);
  }
  return JSON.stringify(subjects);
}
