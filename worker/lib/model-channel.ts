import type { ResolvedModelProfile } from '../../shared/config/models';
import { transformModelRequest } from './model-extensions';

/** Protocol adapters own the wire format; extensions own exceptional dialects. */
export function channelRequestBody(
  profile: Pick<ResolvedModelProfile, 'requestDialect' | 'compatibility'>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  let result = body;
  if (profile.compatibility?.maxTokensField === 'max_completion_tokens' && body.max_tokens !== undefined) {
    result = { ...body, max_completion_tokens: body.max_tokens };
    delete result.max_tokens;
  }
  return transformModelRequest(profile, result);
}
