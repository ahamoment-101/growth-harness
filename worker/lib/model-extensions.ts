import type { ResolvedModelProfile } from '../../shared/config/models';

/** Distribution seam; the public distribution has no vendor-specific transforms. */
export function transformModelRequest(
  _profile: Pick<ResolvedModelProfile, 'requestDialect'>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return body;
}
