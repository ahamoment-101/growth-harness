import { describe, expect, it } from 'vitest';
import { agentDefinition } from '../agent-runtime/definitions';
import { learningJudgmentInstructions, leaderLearningJudgmentInstructions, learningTitleInstructions } from './judgment-contract';
import { learningTools } from './agent';
import type { AgentTask } from '../agent-runtime/task-store';
import type { RuntimeAgentEnv } from '../agent-runtime/env';
import { z } from 'zod';

describe('learning judgment contract versions', () => {
  it('leaves historical prompts unchanged and enables the new guidance for newly created tasks', () => {
    for (let version = 1; version <= 3; version++) expect(learningJudgmentInstructions(version)).toBe('');
    for (let version = 1; version <= 22; version++) expect(leaderLearningJudgmentInstructions(version)).toBe('');
    expect(learningJudgmentInstructions(agentDefinition('learning_agent').definitionVersion)).not.toBe('');
    expect(leaderLearningJudgmentInstructions(agentDefinition('growth_leader').definitionVersion)).not.toBe('');
  });

  it('pins historical tool schemas while publishing field semantics without adding business validation rules', () => {
    const definition = agentDefinition('learning_agent');
    const tool = (version: number) => learningTools({} as RuntimeAgentEnv, { definition_version: version } as AgentTask).resolve(definition, 'submit_learning_result');
    const before = tool(3), current = tool(5);
    expect(before.version).toBe(3);
    expect(current.version).toBe(5);
    const oldSchema = z.toJSONSchema(before.inputSchema), newSchema = z.toJSONSchema(current.inputSchema);
    const stripDescriptions = (schema: unknown): unknown => Array.isArray(schema) ? schema.map(stripDescriptions)
      : schema && typeof schema === 'object' ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'description').map(([key, value]) => [key, stripDescriptions(value)])) : schema;
    expect(stripDescriptions(newSchema)).toEqual(oldSchema);
    expect(JSON.stringify(newSchema)).not.toBe(JSON.stringify(oldSchema));
  });

  it('adds title guidance only to new tasks without changing accepted titles or historical tool descriptions', () => {
    const definition = agentDefinition('learning_agent');
    const tool = (version: number) => learningTools({} as RuntimeAgentEnv, { definition_version: version } as AgentTask).resolve(definition, 'submit_learning_result');
    for (let version = 1; version <= 4; version++) expect(learningTitleInstructions(version)).toBe('');
    const guidance = learningTitleInstructions(definition.definitionVersion).trim();
    expect(guidance).not.toBe('');
    const before = tool(4), current = tool(5);
    expect(before.version).toBe(4);
    expect(current.version).toBe(5);
    const oldSchema = z.toJSONSchema(before.inputSchema), newSchema = z.toJSONSchema(current.inputSchema);
    expect(newSchema.properties!.title).toEqual({ type: 'string', minLength: 1, description: guidance });
    expect({ ...newSchema, properties: { ...newSchema.properties, title: oldSchema.properties!.title } }).toEqual(oldSchema);
  });
});
