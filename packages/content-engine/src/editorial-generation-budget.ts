/** Budget reserved for a full website article, independent from short radar summaries. */
export const WEBSITE_EDITORIAL_GENERATION_BUDGET = {
  contextTokens: 4096,
  outputTokens: 768,
  minimumWords: 180,
  targetMinimumWords: 220,
  targetMaximumWords: 240,
  maximumWords: 300,
  jsonAndInstructionMarginTokens: 220,
} as const;

export const RADAR_SUMMARY_GENERATION_BUDGET = {
  contextTokens: 4096,
  outputTokens: 160,
} as const;

export function approximateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
