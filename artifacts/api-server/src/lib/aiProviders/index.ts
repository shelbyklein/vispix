import { eq } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  APP_SETTINGS_SINGLETON_ID,
  organizationSettingsTable,
  type AppSettings,
  type OrganizationSettings,
} from "@workspace/db";
import { decryptSecret } from "../secretCrypto";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import {
  AnalysisProvider,
  DEFAULT_PROVIDER_MODELS,
  ModelOption,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_DETAILS,
  PROVIDER_MODEL_OPTIONS,
  ProviderId,
} from "./types";
import { logger } from "../logger";

export {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_OPTIONS,
  PROVIDER_MODEL_DETAILS,
  DEFAULT_PROVIDER_MODELS,
  type ModelOption,
  type ProviderId,
} from "./types";

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  model: string;
  availableModels: ModelOption[];
  hasKey: boolean;
  keyPreview: string | null;
  envKeyFallbackAvailable: boolean;
  usable: boolean;
}

export interface ResolvedSettings {
  enabled: boolean;
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderStatus>;
  hasUsableActive: boolean;
}

export async function loadAppSettings(): Promise<AppSettings> {
  const [existing] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.id, APP_SETTINGS_SINGLETON_ID));
  if (existing) return existing;
  const [created] = await db
    .insert(appSettingsTable)
    .values({ id: APP_SETTINGS_SINGLETON_ID })
    .returning();
  return created;
}

// Per-org AI/embedding/image settings (issue #113, Phase 3). Creates a defaults
// row on first access. organization_settings carries the same AI columns as
// app_settings, so the shared summarize/getStoredKey/getActiveProvider helpers
// operate on it structurally — only registration stays instance-level.
export async function loadOrgSettings(organizationId: number): Promise<OrganizationSettings> {
  const [existing] = await db
    .select()
    .from(organizationSettingsTable)
    .where(eq(organizationSettingsTable.organizationId, organizationId));
  if (existing) return existing;
  const [created] = await db
    .insert(organizationSettingsTable)
    .values({ organizationId })
    .returning();
  return created;
}

// True when the AI_INTEGRATIONS_* env vars supply a base URL + API key for this
// provider, i.e. a server-configured fallback used when no admin key is set in
// the UI. (Formerly Replit's built-in AI gateway; now a generic env fallback.)
function envKeyFallbackFor(id: ProviderId): boolean {
  if (id === "openai") {
    return Boolean(
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY &&
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    );
  }
  if (id === "anthropic") {
    return Boolean(
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY &&
        process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    );
  }
  return Boolean(
    process.env.AI_INTEGRATIONS_GEMINI_API_KEY &&
      process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  );
}

function providerHasKey(settings: OrganizationSettings, id: ProviderId): boolean {
  if (id === "openai") return Boolean(settings.openaiKeyCiphertext);
  if (id === "anthropic") return Boolean(settings.anthropicKeyCiphertext);
  return Boolean(settings.geminiKeyCiphertext);
}

function providerPreview(settings: OrganizationSettings, id: ProviderId): string | null {
  if (id === "openai") return settings.openaiKeyPreview;
  if (id === "anthropic") return settings.anthropicKeyPreview;
  return settings.geminiKeyPreview;
}

function configuredModelFor(
  settings: OrganizationSettings,
  id: ProviderId,
): string | null {
  if (id === "openai") return settings.openaiModel;
  if (id === "anthropic") return settings.anthropicModel;
  return settings.geminiModel;
}

export function resolveProviderModel(
  settings: OrganizationSettings,
  id: ProviderId,
): string {
  const stored = configuredModelFor(settings, id);
  if (stored && PROVIDER_MODEL_OPTIONS[id].includes(stored)) return stored;
  return DEFAULT_PROVIDER_MODELS[id];
}

export function summarizeSettings(settings: OrganizationSettings): ResolvedSettings {
  const providers = {} as Record<ProviderId, ProviderStatus>;
  for (const id of PROVIDER_IDS) {
    const hasKey = providerHasKey(settings, id);
    const fallback = envKeyFallbackFor(id);
    providers[id] = {
      id,
      label: PROVIDER_LABELS[id],
      model: resolveProviderModel(settings, id),
      availableModels: PROVIDER_MODEL_DETAILS[id],
      hasKey,
      keyPreview: providerPreview(settings, id),
      envKeyFallbackAvailable: fallback,
      usable: hasKey || fallback,
    };
  }
  const active = (settings.activeProvider as ProviderId) ?? "openai";
  return {
    enabled: settings.aiEnabled,
    activeProvider: PROVIDER_IDS.includes(active) ? active : "openai",
    providers,
    hasUsableActive:
      providers[PROVIDER_IDS.includes(active) ? active : "openai"].usable,
  };
}

function getStoredKey(
  settings: OrganizationSettings,
  id: ProviderId,
): string | null {
  try {
    if (id === "openai") {
      if (
        !settings.openaiKeyCiphertext ||
        !settings.openaiKeyIv ||
        !settings.openaiKeyTag
      )
        return null;
      return decryptSecret({
        ciphertext: settings.openaiKeyCiphertext,
        iv: settings.openaiKeyIv,
        tag: settings.openaiKeyTag,
      });
    }
    if (id === "anthropic") {
      if (
        !settings.anthropicKeyCiphertext ||
        !settings.anthropicKeyIv ||
        !settings.anthropicKeyTag
      )
        return null;
      return decryptSecret({
        ciphertext: settings.anthropicKeyCiphertext,
        iv: settings.anthropicKeyIv,
        tag: settings.anthropicKeyTag,
      });
    }
    if (
      !settings.geminiKeyCiphertext ||
      !settings.geminiKeyIv ||
      !settings.geminiKeyTag
    )
      return null;
    return decryptSecret({
      ciphertext: settings.geminiKeyCiphertext,
      iv: settings.geminiKeyIv,
      tag: settings.geminiKeyTag,
    });
  } catch (err) {
    logger.error({ err, providerId: id }, "Failed to decrypt provider key");
    return null;
  }
}

export async function getActiveProvider(organizationId: number): Promise<{
  provider: AnalysisProvider | null;
  settings: OrganizationSettings;
  reason?: string;
}> {
  const settings = await loadOrgSettings(organizationId);
  if (!settings.aiEnabled) {
    return { provider: null, settings, reason: "AI disabled" };
  }
  const id = (settings.activeProvider as ProviderId) ?? "openai";
  const adminKey = getStoredKey(settings, id);
  const model = resolveProviderModel(settings, id);

  if (id === "openai") {
    if (adminKey)
      return { provider: new OpenAIProvider(adminKey, null, model), settings };
    if (envKeyFallbackFor("openai")) {
      return {
        provider: new OpenAIProvider(
          process.env.AI_INTEGRATIONS_OPENAI_API_KEY!,
          process.env.AI_INTEGRATIONS_OPENAI_BASE_URL!,
          model,
        ),
        settings,
      };
    }
    return { provider: null, settings, reason: "No OpenAI key configured" };
  }
  if (id === "anthropic") {
    if (adminKey)
      return {
        provider: new AnthropicProvider(adminKey, null, model),
        settings,
      };
    if (envKeyFallbackFor("anthropic")) {
      return {
        provider: new AnthropicProvider(
          process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
          process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL!,
          model,
        ),
        settings,
      };
    }
    return { provider: null, settings, reason: "No Anthropic key configured" };
  }
  if (adminKey)
    return { provider: new GeminiProvider(adminKey, undefined, model), settings };
  if (envKeyFallbackFor("gemini")) {
    return {
      provider: new GeminiProvider(
        process.env.AI_INTEGRATIONS_GEMINI_API_KEY!,
        process.env.AI_INTEGRATIONS_GEMINI_BASE_URL!,
        model,
      ),
      settings,
    };
  }
  return { provider: null, settings, reason: "No Gemini key configured" };
}

/**
 * Decrypted OpenAI API key for an org, regardless of which provider is active
 * for photo analysis — image generation (#167) is OpenAI-only, billed to the
 * org's own key. Falls back to the instance-wide env key when the org hasn't
 * stored one. Null → the Create workspace is unavailable for this org.
 */
export async function getOpenAIKeyForOrg(
  organizationId: number,
): Promise<{ apiKey: string; baseURL: string | null } | null> {
  const settings = await loadOrgSettings(organizationId);
  if (!settings.aiEnabled) return null;
  const stored = getStoredKey(settings, "openai");
  if (stored) return { apiKey: stored, baseURL: null };
  if (envKeyFallbackFor("openai")) {
    return {
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY!,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? null,
    };
  }
  return null;
}
