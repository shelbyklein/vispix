CREATE TABLE "image_generation_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"parent_generation_id" integer,
	"prompt" text NOT NULL,
	"openai_response_id" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_notes_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"storage_key" text,
	"content_type" text,
	"width" integer,
	"height" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_generation_sessions" ADD CONSTRAINT "image_generation_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generation_sessions" ADD CONSTRAINT "image_generation_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_session_id_image_generation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."image_generation_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_parent_generation_id_image_generations_id_fk" FOREIGN KEY ("parent_generation_id") REFERENCES "public"."image_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_gen_sessions_org_idx" ON "image_generation_sessions" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "image_generations_session_idx" ON "image_generations" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "image_generations_org_idx" ON "image_generations" USING btree ("organization_id");