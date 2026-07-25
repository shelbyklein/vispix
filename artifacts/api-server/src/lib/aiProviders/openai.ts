import OpenAI from "openai";
import { logger } from "../logger";
import {
  AnalysisProvider,
  AnalysisRequest,
  DEFAULT_PROVIDER_MODELS,
  EVALUATION_SCHEMA_FRAGMENT,
  RawAnalysisResult,
} from "./types";

export class OpenAIProvider implements AnalysisProvider {
  id = "openai" as const;
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, baseURL?: string | null, model?: string | null) {
    this.client = new OpenAI({ apiKey, baseURL: baseURL ?? undefined });
    this.model = model || DEFAULT_PROVIDER_MODELS.openai;
  }

  async generateText(systemPrompt: string, userText: string): Promise<string | null> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        response_format: { type: "json_object" },
      });
      return response.choices[0]?.message?.content ?? null;
    } catch (err) {
      logger.error({ err }, "OpenAI text generation failed");
      return null;
    }
  }

  async analyze(req: AnalysisRequest): Promise<RawAnalysisResult | null> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: 8192,
        messages: [
          { role: "system", content: req.systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: req.userText },
              { type: "image_url", image_url: { url: req.imageDataUrl } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "photo_analysis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                description: { type: "string" },
                suggestedCollectionIds: {
                  type: "array",
                  items: { type: "integer" },
                  maxItems: 3,
                },
                suggestedNewCollectionNames: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 2,
                },
                evaluation: EVALUATION_SCHEMA_FRAGMENT,
              },
              required: ["description", "suggestedCollectionIds", "suggestedNewCollectionNames", "evaluation"],
            },
          },
        },
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as RawAnalysisResult;
      return {
        description: String(parsed.description ?? "").trim(),
        suggestedCollectionIds: Array.isArray(parsed.suggestedCollectionIds)
          ? parsed.suggestedCollectionIds
          : [],
        suggestedNewCollectionNames: Array.isArray(parsed.suggestedNewCollectionNames)
          ? parsed.suggestedNewCollectionNames.map((n) => String(n).trim()).filter(Boolean)
          : [],
        evaluation: parsed.evaluation ?? null,
      };
    } catch (err) {
      // Surface the real provider error (e.g. a 400 "unsupported image") to the
      // caller so it's recorded on the ai_analysis_events row, instead of being
      // masked as a generic "Provider returned no result".
      logger.error({ err }, "OpenAI photo analysis failed");
      throw err;
    }
  }
}
