import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const shortText = z.string().trim().min(1).max(160);
const condition = z.object({ field: id, equals: z.string().min(1).max(100) }).strict();

const option = z.object({ value: id, label: shortText, description: z.string().max(500).optional() }).strict();

const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ type: z.literal('notice'), title: shortText.optional(), text: z.string().trim().min(1).max(2000), tone: z.enum(['neutral', 'warning']).default('neutral') }).strict(),
  z.object({ type: z.literal('reference'), label: shortText, detail: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ type: z.literal('separator') }).strict(),
  z.object({ type: z.literal('choice'), id, label: shortText, options: z.array(option).min(2).max(12), required: z.boolean().default(false), show_when: condition.optional() }).strict(),
  z.object({ type: z.literal('text_input'), id, label: shortText, placeholder: z.string().max(160).optional(), max_length: z.number().int().min(1).max(2000).default(500), required: z.boolean().default(false), show_when: condition.optional() }).strict(),
  z.object({ type: z.literal('textarea'), id, label: shortText, placeholder: z.string().max(160).optional(), max_length: z.number().int().min(1).max(10000).default(2000), required: z.boolean().default(false), show_when: condition.optional() }).strict(),
]);

export const hitlSpecSchema = z.object({
  schema_version: z.literal(1),
  title: shortText,
  description: z.string().max(1000).optional(),
  blocks: z.array(block).min(1).max(30),
  actions: z.array(z.object({ id, label: shortText, tone: z.enum(['primary', 'secondary', 'danger']).default('secondary'), required_fields: z.array(id).max(20).default([]) }).strict()).min(1).max(5),
}).strict();

export type HitlSpec = z.infer<typeof hitlSpecSchema>;
export type HitlBlock = HitlSpec['blocks'][number];
export type HitlField = Extract<HitlBlock, { id: string }>;
export type HitlRequest = { id: string; version: string; spec: HitlSpec };
export type HitlResponse = { request_id: string; version: string; action: string; values: Record<string, string> };

const isField = (block: HitlBlock): block is HitlField => 'id' in block;

/** Validate model-composed HITL content before it can reach a human. */
export function parseHitlSpec(input: unknown): HitlSpec {
  const spec = hitlSpecSchema.parse(input);
  const seen = new Map<string, HitlField>();
  for (const block of spec.blocks) {
    if (!isField(block)) continue;
    if (seen.has(block.id)) throw new Error(`Duplicate field: ${block.id}`);
    if (block.show_when) {
      const parent = seen.get(block.show_when.field);
      if (!parent || parent.type !== 'choice' || !parent.options.some(item => item.value === block.show_when!.equals)) {
        throw new Error(`Invalid visibility condition for ${block.id}`);
      }
    }
    if (block.type === 'choice' && new Set(block.options.map(item => item.value)).size !== block.options.length) {
      throw new Error(`Duplicate choice option: ${block.id}`);
    }
    seen.set(block.id, block);
  }
  if (new Set(spec.actions.map(action => action.id)).size !== spec.actions.length) throw new Error('Duplicate action');
  for (const action of spec.actions) {
    for (const field of action.required_fields) if (!seen.has(field)) throw new Error(`Unknown required field: ${field}`);
  }
  return spec;
}

export function isVisible(block: HitlBlock, values: Record<string, string>): boolean {
  return !('show_when' in block && block.show_when) || values[block.show_when.field] === block.show_when.equals;
}

/** No action here performs a business effect; it only records what the human submitted. */
export function createHitlResponse(request: HitlRequest, actionId: string, values: Record<string, string>): HitlResponse {
  const spec = parseHitlSpec(request.spec);
  if (!request.id.trim() || !request.version.trim()) throw new Error('Request identity is missing');
  const action = spec.actions.find(item => item.id === actionId);
  if (!action) throw new Error('Unknown action');
  const fields = spec.blocks.filter(isField);
  const known = new Set(fields.map(field => field.id));
  for (const [key, value] of Object.entries(values)) {
    if (!known.has(key) || typeof value !== 'string') throw new Error(`Unexpected field: ${key}`);
  }
  const accepted: Record<string, string> = {};
  for (const field of fields) {
    if (!isVisible(field, values)) continue;
    const value = (values[field.id] || '').trim();
    if (value.length > (field.type === 'choice' ? 100 : field.max_length)) throw new Error(`${field.label} is too long`);
    if ((field.required || action.required_fields.includes(field.id)) && !value) throw new Error(`Please fill in ${field.label}`);
    if (field.type === 'choice' && value && !field.options.some(item => item.value === value)) throw new Error(`${field.label} option is invalid`);
    if (value) accepted[field.id] = value;
  }
  return { request_id: request.id, version: request.version, action: actionId, values: accepted };
}
