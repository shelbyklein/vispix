import { pgTable, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import type { PlatformTheme } from "@workspace/api-zod/theme";

export const APP_SETTINGS_SINGLETON_ID = 1;

export const appSettingsTable = pgTable("app_settings", {
  id: integer("id").primaryKey(),
  registrationEnabled: boolean("registration_enabled").notNull().default(true),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  activeProvider: text("active_provider").notNull().default("openai"),

  aiAutoBackfillEnabled: boolean("ai_auto_backfill_enabled").notNull().default(false),
  aiAutoBackfillBatchSize: integer("ai_auto_backfill_batch_size").notNull().default(10),

  openaiKeyCiphertext: text("openai_key_ciphertext"),
  openaiKeyIv: text("openai_key_iv"),
  openaiKeyTag: text("openai_key_tag"),
  openaiKeyPreview: text("openai_key_preview"),
  openaiModel: text("openai_model"),

  anthropicKeyCiphertext: text("anthropic_key_ciphertext"),
  anthropicKeyIv: text("anthropic_key_iv"),
  anthropicKeyTag: text("anthropic_key_tag"),
  anthropicKeyPreview: text("anthropic_key_preview"),
  anthropicModel: text("anthropic_model"),

  geminiKeyCiphertext: text("gemini_key_ciphertext"),
  geminiKeyIv: text("gemini_key_iv"),
  geminiKeyTag: text("gemini_key_tag"),
  geminiKeyPreview: text("gemini_key_preview"),
  geminiModel: text("gemini_model"),

  // Image embeddings via Google Vertex AI (multimodalembedding@001). Auth is
  // ADC (GOOGLE_APPLICATION_CREDENTIALS) and the GCP project/location come from
  // env — matching how object storage uses ADC — so only the on/off toggle and
  // an optional model override live here.
  embeddingEnabled: boolean("embedding_enabled").notNull().default(false),
  embeddingModel: text("embedding_model"),

  // Re-encode newly-uploaded originals to WebP on import (server-side, via
  // sharp) to save storage while preserving EXIF/orientation. On by default.
  imageOptimizationEnabled: boolean("image_optimization_enabled").notNull().default(true),

  // Platform theme (#253): the superadmin-edited design tokens served as
  // /api/theme.css. Null = the built-in index.css theme.
  theme: jsonb("theme").$type<PlatformTheme>(),
  themeUpdatedAt: timestamp("theme_updated_at", { withTimezone: true }),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppSettings = typeof appSettingsTable.$inferSelect;
