/** Public work records; never a model transcript or private reasoning. */
import type { HitlSpec } from './hitl';
export type WorkField = { id: string; label: string; kind: 'text' | 'textarea' | 'select'; options?: Array<{ value: string; label: string }>; max_length?: number };
export type WorkAction = { id: string; label: string; description?: string; required_fields?: string[]; input_mode?: 'popover'; tone?: 'primary' | 'danger'; href?: string };
export type WorkInteraction = {
  id: string; version: string; state: 'pending' | 'resolved';
  fields: WorkField[]; actions: WorkAction[];
  spec?: HitlSpec;
  pending_submission?: WorkResponse;
  response?: { label: string; note: string; at: string; action?: string; values?: Record<string, string>; outcome?: 'superseded' };
};
export type WorkNode = {
  id: string; at: string; title: string; body?: string;
  state: 'working' | 'recorded' | 'attention' | 'failed' | 'resolved';
  materials?: Array<{ title: string; markdown: string }>;
  records?: Array<{ id: string; label: string; status: string; error: string }>;
  interaction?: WorkInteraction;
};
export type WorkStream = { nodes: WorkNode[]; next_cursor: string | null };
export type WorkResponse = { request_id: string; version: string; action: string; values: Record<string, string>; command_id: string };
export type WorkResponseReceipt = { message: string; outcome?: 'superseded' };
