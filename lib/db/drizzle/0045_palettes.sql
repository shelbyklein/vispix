CREATE TABLE "design_palettes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"swatches" jsonb NOT NULL,
	"roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"harmony" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_palettes" ADD CONSTRAINT "design_palettes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;