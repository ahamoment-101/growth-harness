/** Domain capabilities, deliberately independent of Agent names or definitions. */
export const libraryToolSets = {
  read: ['list_library_entries', 'read_library_entry', 'read_library_logs'],
  research: [
    'create_library_keyword', 'revise_library_keyword',
    'create_library_topic_group', 'revise_library_topic_group',
    'create_library_cluster', 'revise_library_cluster',
    'organize_library_membership',
  ],
  topicLinks: ['relate_library_topic'],
} as const;
export type LibraryToolSet = keyof typeof libraryToolSets;
export type LibraryToolName = typeof libraryToolSets[LibraryToolSet][number];

/** Selection is explicit; selecting writes does not silently grant other capabilities. */
export function libraryToolNames(sets: readonly LibraryToolSet[]): LibraryToolName[] {
  return [...new Set(sets.flatMap((set) => {
    if (!Object.prototype.hasOwnProperty.call(libraryToolSets, set)) throw new Error(`Unknown library tool set: ${set}`);
    return [...libraryToolSets[set]];
  }))];
}
