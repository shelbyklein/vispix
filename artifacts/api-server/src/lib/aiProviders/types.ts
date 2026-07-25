export type ProviderId = "openai" | "anthropic" | "gemini";

export const PROVIDER_IDS: ProviderId[] = ["openai", "anthropic", "gemini"];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODEL_DETAILS: Record<ProviderId, ModelOption[]> = {
  openai: [
    { id: "gpt-5.4", label: "Best quality — slowest, most expensive" },
    { id: "gpt-5", label: "High quality — balanced cost" },
    { id: "gpt-5-mini", label: "Balanced — recommended" },
    { id: "gpt-5-nano", label: "Fastest, cheapest" },
  ],
  anthropic: [
    { id: "claude-opus-4-7", label: "Best quality — slowest, most expensive" },
    { id: "claude-sonnet-4-6", label: "Balanced — recommended" },
    { id: "claude-haiku-4-5", label: "Fastest, cheapest" },
  ],
  gemini: [
    { id: "gemini-3.1-pro-preview", label: "Best quality (preview) — slower" },
    { id: "gemini-3-flash-preview", label: "Fast preview — newest" },
    { id: "gemini-2.5-pro", label: "High quality — stable" },
    { id: "gemini-2.5-flash", label: "Fastest, cheapest — recommended" },
  ],
};

export const PROVIDER_MODEL_OPTIONS: Record<ProviderId, string[]> = {
  openai: PROVIDER_MODEL_DETAILS.openai.map((m) => m.id),
  anthropic: PROVIDER_MODEL_DETAILS.anthropic.map((m) => m.id),
  gemini: PROVIDER_MODEL_DETAILS.gemini.map((m) => m.id),
};

export const DEFAULT_PROVIDER_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-flash",
};

/** @deprecated Use DEFAULT_PROVIDER_MODELS for the default and the configured value at runtime. */
export const PROVIDER_MODELS: Record<ProviderId, string> = DEFAULT_PROVIDER_MODELS;

export interface AnalysisRequest {
  imageDataUrl: string;
  contentType: string;
  systemPrompt: string;
  userText: string;
}

// Criteria scores from the same analysis call (#181): 0–10 each, plus detected
// flaws and which crops/uses the framing suits. Providers return this raw and
// unvalidated; lib/aiEvaluation.ts normalizes/clamps before persistence.
export interface RawPhotoEvaluation {
  technicalQuality: number;
  composition: number;
  subjectClarity: number;
  emotionalImpact: number;
  marketingUsability: number;
  flaws: string[];
  orientationSuitability: string;
}

export interface RawAnalysisResult {
  description: string;
  suggestedCollectionIds: number[];
  suggestedNewCollectionNames?: string[];
  evaluation?: RawPhotoEvaluation | null;
}

// Shared JSON-schema fragment for the evaluation block, in the plain
// draft-style shape OpenAI (strict json_schema) and Anthropic (tool
// input_schema) both accept. Gemini's typed schema mirrors this in gemini.ts.
export const EVALUATION_SCHEMA_FRAGMENT = {
  type: "object",
  additionalProperties: false,
  properties: {
    technicalQuality: { type: "integer" },
    composition: { type: "integer" },
    subjectClarity: { type: "integer" },
    emotionalImpact: { type: "integer" },
    marketingUsability: { type: "integer" },
    flaws: { type: "array", items: { type: "string" }, maxItems: 6 },
    orientationSuitability: { type: "string" },
  },
  required: [
    "technicalQuality",
    "composition",
    "subjectClarity",
    "emotionalImpact",
    "marketingUsability",
    "flaws",
    "orientationSuitability",
  ],
} as const;

export interface AnalysisProvider {
  id: ProviderId;
  analyze(req: AnalysisRequest): Promise<RawAnalysisResult | null>;
  generateText(systemPrompt: string, userText: string): Promise<string | null>;
}
