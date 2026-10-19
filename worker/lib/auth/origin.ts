export function unsafeOriginError(request: Request): string {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return 'cross-origin state change is not allowed';
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return 'cross-site state change is not allowed';
  return '';
}

export function agentTransportOriginError(request: Request): string {
  const unsafe = unsafeOriginError(request);
  if (unsafe) return unsafe;
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && !request.headers.get('Origin')) {
    return 'WebSocket Origin is required';
  }
  return '';
}
