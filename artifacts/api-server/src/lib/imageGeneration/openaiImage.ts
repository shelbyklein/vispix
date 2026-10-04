import OpenAI from "openai";
import { logger } from "../logger";

// OpenAI image generation (#167) via the Responses API + image_generation tool.
// Revisions are stateless: the caller re-sends the current image and context
// with each request (store is false, so no response is retained to chain to).

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
  /** Images as data URLs: the references, or on a revision the current design. */
  inputImages?: string[];
  size: ImageSize;
}

export interface GeneratedImage {
  /** PNG bytes. */
  buffer: Buffer;
  responseId: string;
  imageModel: string;
}

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  // Hard cap per call so a hung request can't strand a pending generation.
  const client = new OpenAI({ apiKey: args.apiKey, baseURL: args.baseURL ?? undefined, timeout: 240_000 });

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
    // Provider-side retention off: OpenAI must not keep our briefs or images
    // (#243). Revisions therefore re-send the parent image instead of chaining
    // previous_response_id, which needs stored responses.
    store: false,
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
