CREATE TABLE "photo_ai_evaluations" (
	"photo_id" integer PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"technical_quality" smallint NOT NULL,
	"composition" smallint NOT NULL,
	"subject_clarity" smallint NOT NULL,
	"emotional_impact" smallint NOT NULL,
	"marketing_usability" smallint NOT NULL,
	"overall_score" real NOT NULL,
	"flaws" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"orientation_suitability" text,
	"provider" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_ai_evaluations" ADD CONSTRAINT "photo_ai_evaluations_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_ai_evaluations" ADD CONSTRAINT "photo_ai_evaluations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_ai_eval_org_score_idx" ON "photo_ai_evaluations" USING btree ("organization_id","overall_score");