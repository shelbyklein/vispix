import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger";
import {
  AnalysisProvider,
  AnalysisRequest,
  DEFAULT_PROVIDER_MODELS,
  EVALUATION_SCHEMA_FRAGMENT,
  RawAnalysisResult,
} from "./types";

const TOOL_NAME = "submit_photo_analysis";

function extractBase64FromDataUrl(dataUrl: string): {
  mediaType: string;
  data: string;
} | null {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

export class AnthropicProvider implements AnalysisProvider {
  id = "anthropic" as const;
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, baseURL?: string | null, model?: string | null) {
    this.client = new Anthropic({ apiKey, baseURL: baseURL ?? undefined });
    this.model = model || DEFAULT_PROVIDER_MODELS.anthropic;
  }

  async generateText(systemPrompt: string, userText: string): Promise<string | null> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userText }],
      });
      const block = response.content.find((b) => b.type === "text");
      return block?.type === "text" ? block.text : null;
    } catch (err) {
      logger.error({ err }, "Anthropic text generation failed");
      return null;
    }
  }

  async analyze(req: AnalysisRequest): Promise<RawAnalysisResult | null> {
    try {
      const img = extractBase64FromDataUrl(req.imageDataUrl);
      if (!img) {
        logger.warn("Anthropic provider needs base64 data URL; falling back to URL");
      }

      const imageBlock: Anthropic.Messages.ImageBlockParam = img
        ? {
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: img.data,
            },
          }
        : {
            type: "image",
            source: { type: "url", url: req.imageDataUrl },
          };

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: req.systemPrompt,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Submit a photo description, a list of suggested existing collection ids, and optionally suggested new collection names.",
            input_schema: {
              type: "object",
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
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [imageBlock, { type: "text", text: req.userText }],
          },
        ],
      });

      const toolUse = response.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (!toolUse) return null;
      const input = toolUse.input as RawAnalysisResult;
      return {
        description: String(input.description ?? "").trim(),
        suggestedCollectionIds: Array.isArray(input.suggestedCollectionIds)
          ? input.suggestedCollectionIds
          : [],
        suggestedNewCollectionNames: Array.isArray(input.suggestedNewCollectionNames)
          ? input.suggestedNewCollectionNames.map((n: unknown) => String(n).trim()).filter(Boolean)
          : [],
        evaluation: input.evaluation ?? null,
      };
    } catch (err) {
      // Surface the real provider error so it lands on the ai_analysis_events
      // row instead of being masked as a generic "Provider returned no result".
      logger.error({ err }, "Anthropic photo analysis failed");
      throw err;
    }
  }
}
