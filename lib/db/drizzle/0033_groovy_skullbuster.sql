CREATE TABLE "organization_alerts" (
	"organization_id" integer NOT NULL,
	"kind" text NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_alerts_organization_id_kind_pk" PRIMARY KEY("organization_id","kind")
);
--> statement-breakpoint
ALTER TABLE "organization_alerts" ADD CONSTRAINT "organization_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;