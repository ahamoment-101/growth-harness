/** A site-owned practice. Agent identities describe contributions, never ownership. */
export type LearningScope = { workspaceId: string; siteId: string };
export type EvaluationInput = { name: string; unit: string; source: string };
export type CalculationStep = {
  name: string;
  op: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max';
  left: string;
  right: string;
};
export type EvaluationAgreement = {
  version: number;
  objective: string;
  basis: string[];
  inputs: EvaluationInput[];
  method: 'numeric' | 'rubric';
  constants: Record<string, number>;
  steps: CalculationStep[];
  output: string;
  rubric: string;
  score_meaning: string;
  unavailable_when: string[];
  comparison_key: string;
};
export type LearningData = {
  intent: { goal: string; context: string; expectation: string };
  experience: {
    insight?: string;
    hypothesis: string;
    approach: string;
    adjustments: string[];
    delivery: string;
    evaluation: EvaluationAgreement | null;
    observation: {
      source: 'gsc' | 'unavailable';
      start: 'publication';
      days: number;
      signals: string[];
      rationale: string;
    } | null;
    assessment: {
      reward: number | null;
      conclusion: string;
      limitations: string[];
      evidence_refs: string[];
    } | null;
    preparation: 'pending' | 'ready' | 'skipped';
    gaps: string[];
  };
  utility: {
    score: number | null;
    feedback_count: number;
    calculation_version: string;
  };
};
export type LearningRecord = LearningData & {
  id: string;
  version: number;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
};
export type LearningUse = {
  feedback_reward?: number | null;
  feedback_received?: number;
  observed_version: number;
  practice_id: string;
  experience_id: string;
  task_id: string;
  agent_id: string;
  reason: string;
  compatibility: string;
  created_at: string;
};
export type LearningEvidence = {
  id: string;
  record_id: string;
  kind: string;
  source_ref: string;
  payload: unknown;
  created_at: string;
};
export type LearningDetail = {
  record: LearningRecord;
  evidence: LearningEvidence[];
  uses: LearningUse[];
  adopted_by: LearningUse[];
  next_cursors: Partial<
    Record<
      'evidence' | 'uses' | 'adopted_by' | 'tasks' | 'observations',
      string
    >
  >;
  processing: Array<{
    id: string;
    phase: string;
    status: string;
    error: string;
    failure_count: number;
  }>;
  tasks: Array<{ task_id: string; agent_id: string }>;
  observations: Array<{
    id: string;
    url: string;
    start_date: string;
    end_date: string;
    status: string;
    error: string;
  }>;
};

export type LearningSection =
  | 'evidence'
  | 'uses'
  | 'adopted_by'
  | 'tasks'
  | 'observations';
export type LearningPage = {
  section: LearningSection;
  items: Array<
    | LearningEvidence
    | LearningUse
    | LearningDetail['tasks'][number]
    | LearningDetail['observations'][number]
  >;
  next_cursor: string | null;
};
