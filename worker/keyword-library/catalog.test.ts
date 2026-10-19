import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentDefinition } from '../agent-runtime/definitions';
import { libraryToolNames } from './catalog';
import { createKeywordLibraryTools } from './tools';

const bind = async (): Promise<never> => { throw new Error('Binding must be lazy'); };
describe('standalone library tool catalog', () => {
  it('selects only explicitly granted capabilities and shares identical contracts', () => {
    const all = createKeywordLibraryTools(bind);
    const read = createKeywordLibraryTools(bind, { sets: ['read'] });
    expect(all.names()).toHaveLength(11);
    expect(read.names()).toEqual(libraryToolNames(['read']));
    expect(createKeywordLibraryTools(bind, { sets: [] }).names()).toEqual([]);
    expect(libraryToolNames(['read', 'read'])).toHaveLength(3);
    const definition = { ...agentDefinition('strategy_research'), tools: all.names() };
    expect(() => read.resolve(definition, 'create_library_keyword')).toThrow('not registered');
    for (const name of read.names()) {
      expect(z.toJSONSchema(read.resolve(definition, name).inputSchema, { io: 'input' }))
        .toEqual(z.toJSONSchema(all.resolve(definition, name).inputSchema, { io: 'input' }));
    }
  });
  it('exports serializable contracts with explicit Agent capability selection', () => {
    const registry = createKeywordLibraryTools(bind);
    for (const id of ['strategy_research', 'topic_decision'] as const) {
      const definition = agentDefinition(id);
      expect(definition.tools).toContain('list_library_entries');
      expect(definition.tools.includes('create_library_keyword')).toBe(id === 'strategy_research');
      expect(definition.tools.includes('relate_library_topic')).toBe(id === 'topic_decision');
    }
    const definition = { ...agentDefinition('strategy_research'), tools: registry.names() };
    for (const name of registry.names()) {
      const tool = registry.resolve(definition, name);
      const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
      expect(schema.additionalProperties).toBe(false);
      for (const field of ['workspace_id', 'site_id', 'locale', 'market', 'actor', 'operation_id', 'revision']) {
        expect(schema.properties).not.toHaveProperty(field);
      }
      expect(() => z.toJSONSchema(tool.outputSchema)).not.toThrow();
    }
  });
});
