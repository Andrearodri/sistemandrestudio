import { z } from "zod";

/**
 * The editorial model contract is declared once and reused for parsing,
 * prompting and the Ollama structured-output schema. Keep fields deliberately
 * boring: the model may only return plain text values.
 */
export const EditorialOutputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(12_000),
}).strict();

export const RadarSummaryOutputSchema = EditorialOutputSchema.pick({ title: true, body: true }).strict();
export const EditorialBodyRepairSchema = EditorialOutputSchema.pick({ body: true }).strict();

export type EditorialOutput = z.infer<typeof EditorialOutputSchema>;
export type RadarSummaryOutput = z.infer<typeof RadarSummaryOutputSchema>;
export type EditorialBodyRepair = z.infer<typeof EditorialBodyRepairSchema>;

export const EDITORIAL_OUTPUT_JSON_SCHEMA = z.toJSONSchema(EditorialOutputSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
export const RADAR_SUMMARY_OUTPUT_JSON_SCHEMA = z.toJSONSchema(RadarSummaryOutputSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
export const EDITORIAL_BODY_REPAIR_JSON_SCHEMA = z.toJSONSchema(EditorialBodyRepairSchema, { target: "draft-2020-12" }) as Record<string, unknown>;

export const EDITORIAL_OUTPUT_SCHEMA_SUMMARY = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "body"],
  properties: {
    title: { type: "string", maxLength: 120 },
    subtitle: { type: "string", maxLength: 240, description: "uma frase curta em texto simples" },
    body: { type: "string", maxLength: 12_000 },
  },
});
