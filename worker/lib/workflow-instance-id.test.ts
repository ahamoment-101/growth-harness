import { describe, expect, it } from 'vitest';
import { workflowInstanceId } from './workflow-instance-id';

describe('Workflow instance identities', () => {
  it('encodes the durable operation without characters rejected by Cloudflare', () => {
    const id = workflowInstanceId('publish', '20704b3d-3387-44bd-8830-df3982069671:16');
    expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toBe(workflowInstanceId('publish', '20704b3d-3387-44bd-8830-df3982069671:16'));
    expect(id).not.toBe(workflowInstanceId('publish', '20704b3d-3387-44bd-8830-df3982069671-16'));
  });

  it('rejects an unrepresentable identity before a job changes state', () => {
    expect(() => workflowInstanceId('publish', 'x'.repeat(80))).toThrow('cannot represent');
  });
});
