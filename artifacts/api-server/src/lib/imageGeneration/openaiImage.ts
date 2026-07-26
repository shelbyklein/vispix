import OpenAI from "openai";
import { logger } from "../logger";

// OpenAI image generation (#167) via the Responses API + image_generation tool.
// The Responses API (rather than the bare images endpoint) gives us multi-turn
// editing: each response id can be passed back as previous_response_id so
// "make the headline larger" style follow-ups keep the image context.

// The image model does the rendering; a small text model orchestrates the tool
// call. Both overridable by env without a code change.
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const ORCHESTRATOR_MODEL = process.env.OPENAI_IMAGE_TEXT_MODEL || "gpt-5-mini";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";

export interface GenerateImageArgs {
  apiKey: string;
  baseURL?: string | null;
  /** Full generation brief (creative direction + roles + usage notes). */
  brief: string;
  /** Reference images as data URLs; omitted on multi-turn revisions. */
  inputImages?: string[];
  size: ImageSize;
  /** Continue editing a previous result. */
  previousResponseId?: string | null;
}

export interface GeneratedImage {
  /** PNG bytes. */
  buffer: Buffer;
  responseId: string;
  imageModel: string;
}

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const client = new OpenAI({ apiKey: args.apiKey, baseURL: args.baseURL ?? undefined });

  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: args.brief }];
  for (const dataUrl of args.inputImages ?? []) {
    content.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
  }

  // The image_generation tool shape is newer than the SDK's pinned types in
  // places, so the tool config is passed loosely; the API validates it.
  const response = await client.responses.create({
    model: ORCHESTRATOR_MODEL,
    input: [{ role: "user", content }],
    tools: [
      {
        type: "image_generation",
        model: IMAGE_MODEL,
        size: args.size,
        output_format: "png",
      },
    ],
    ...(args.previousResponseId ? { previous_response_id: args.previousResponseId } : {}),
  } as never) as unknown as {
    id: string;
    output?: Array<{ type: string; result?: string | null; status?: string }>;
  };

  const imageCall = response.output?.find((o) => o.type === "image_generation_call");
  if (!imageCall?.result) {
    logger.warn(
      { responseId: response.id, outputTypes: response.output?.map((o) => o.type) },
      "Image generation returned no image",
    );
    throw new Error("The model did not return an image — try rephrasing the request.");
  }

  return {
    buffer: Buffer.from(imageCall.result, "base64"),
    responseId: response.id,
    imageModel: IMAGE_MODEL,
  };
}
