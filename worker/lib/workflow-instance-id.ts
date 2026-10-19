/** Cloudflare user-created Workflow IDs allow letters, digits, underscores and hyphens. */
export function workflowInstanceId(kind: 'publish' | 'localize', operationId: string): string {
  const encoded = btoa(operationId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const id = `${kind}-${encoded}`;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(id) || id.length > 100) {
    throw new Error('Workflow instance ID cannot represent the operation identity');
  }
  return id;
}
