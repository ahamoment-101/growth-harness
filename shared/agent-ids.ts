export const AGENT_IDS = ['learning_agent', 'growth_leader', 'runtime_synthetic', 'runtime_synthetic_child', 'strategy_research', 'business_research', 'deep_research', 'keyword_research', 'topic_decision', 'content_production', 'article_production', 'content_review'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
