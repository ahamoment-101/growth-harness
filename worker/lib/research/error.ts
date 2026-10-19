export function publicStrategyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted due to timeout|TimeoutError/i.test(message)) {
    return 'The model generation did not complete within the time limit. Research evidence has been collected, but strategy generation failed. Please retry later.';
  }
  if (/(?:ModelHttpError:\s*)?Model 401/i.test(message)) {
    return 'Model service authentication failed (401). Please update the configured model API key and retry.';
  }
  if (/(?:ModelHttpError:\s*)?Model 403/i.test(message)) {
    return 'The model service rejected the request (403). The current API Key is restricted by terms of service or permissions. Please check the key status on the configured model provider and retry.';
  }
  if (/(?:ModelHttpError:\s*)?Model 429/i.test(message)) {
    return 'The model service is receiving requests too frequently or the quota is insufficient (429). Please check the model provider quota and retry later.';
  }
  if (/(?:ModelHttpError:\s*)?Model 5\d\d/i.test(message)) {
    return 'The model service is temporarily unavailable. Please retry later.';
  }
  if (/(?:ModelHttpError:\s*)?Model 4\d\d/i.test(message)) {
    return 'The model service rejected the research request. Please check the model, account permissions, and request configuration, then retry.';
  }
  if (/(?:SearchHttpError:\s*)?Web search HTTP 401/i.test(message)) {
    return 'Firecrawl search service authentication failed (401). Please update the Firecrawl API Key and retry.';
  }
  if (/(?:SearchHttpError:\s*)?Web search HTTP 429/i.test(message)) {
    return 'Firecrawl search service requests are too frequent or the quota is insufficient (429). Please check the Firecrawl quota and retry later.';
  }
  if (/(?:SearchHttpError:\s*)?Web search HTTP 5\d\d/i.test(message)) {
    return 'The Firecrawl search service is temporarily unavailable. Please retry later.';
  }
  if (/(?:SearchHttpError:\s*)?Web search HTTP 4\d\d/i.test(message)) {
    return 'The Firecrawl search service rejected the research request. Please check the search service configuration and retry.';
  }
  if (/(?:schema|invalid.*json|json.*parse|validation)/i.test(message)) {
    return 'The structure returned by the model does not conform to the strategy research protocol; the results were not activated this time. Please retry.';
  }
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk-or|fc)-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/\{[\s\S]{20,}/, '[details redacted]')
    .slice(0, 500);
}
