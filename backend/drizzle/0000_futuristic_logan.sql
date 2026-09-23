CREATE TYPE "public"."assertion_status" AS ENUM('imported', 'inferred', 'community_submitted', 'reviewed', 'corroborated', 'verified', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."identifier_namespace" AS ENUM('musicbrainz_recording', 'isrc', 'iswc', 'apple_music', 'spotify', 'acrcloud', 'audd', 'acoustid');--> statement-breakpoint
CREATE TYPE "public"."lineage_classification" AS ENUM('human', 'ai_assisted', 'ai_generated', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."relationship_type" AS ENUM('sampled', 'interpolated', 'covered', 'remixed');--> statement-breakpoint
CREATE TYPE "public"."sample_status" AS ENUM('observed', 'candidate', 'reviewed', 'verified', 'published', 'rejected', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."sample_type" AS ENUM('direct', 'looped', 'chopped', 'pitch_shifted', 'time_stretched', 'filtered', 'layered');--> statement-breakpoint
CREATE TYPE "public"."track_kind" AS ENUM('song', 'film', 'tv', 'comedy', 'speech');--> statement-breakpoint
CREATE TABLE "artists" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "artists_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"canonical_id" text NOT NULL,
	"musicbrainz_artist_id" text,
	"name" text NOT NULL,
	"sort_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artists_canonical_id_unique" UNIQUE("canonical_id"),
	CONSTRAINT "artists_musicbrainz_artist_id_unique" UNIQUE("musicbrainz_artist_id")
);
--> statement-breakpoint
CREATE TABLE "sample_assertions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sample_assertions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sample_id" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_record_id" text DEFAULT '' NOT NULL,
	"source_url" text,
	"evidence_text" text,
	"verification_status" "assertion_status" DEFAULT 'imported' NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_assertions_unique" UNIQUE("sample_id","source_name","source_record_id"),
	CONSTRAINT "sample_assertions_confidence_range" CHECK ("sample_assertions"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "sample_segments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sample_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sample_id" integer NOT NULL,
	"element" text,
	"timestamp_parent" integer,
	"timestamp_child" integer,
	"duration_ms" integer,
	"sample_type" "sample_type",
	"pitch_shift_semitones" real,
	"tempo_ratio" real,
	"is_reversed" boolean,
	"is_looped" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_segments_unique" UNIQUE NULLS NOT DISTINCT("sample_id","element","timestamp_parent","timestamp_child"),
	CONSTRAINT "sample_segments_timestamps_non_negative" CHECK ("sample_segments"."timestamp_parent" >= 0 AND "sample_segments"."timestamp_child" >= 0),
	CONSTRAINT "sample_segments_duration_positive" CHECK ("sample_segments"."duration_ms" > 0),
	CONSTRAINT "sample_segments_tempo_ratio_positive" CHECK ("sample_segments"."tempo_ratio" > 0)
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"canonical_id" text NOT NULL,
	"parent_track_id" integer NOT NULL,
	"child_track_id" integer NOT NULL,
	"relationship_type" "relationship_type" DEFAULT 'sampled' NOT NULL,
	"status" "sample_status" DEFAULT 'candidate' NOT NULL,
	"confidence" real,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "samples_canonical_id_unique" UNIQUE("canonical_id"),
	CONSTRAINT "samples_edge_unique" UNIQUE("parent_track_id","child_track_id","relationship_type"),
	CONSTRAINT "samples_no_self_reference" CHECK ("samples"."parent_track_id" <> "samples"."child_track_id"),
	CONSTRAINT "samples_confidence_range" CHECK ("samples"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "track_aliases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "track_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"track_id" integer NOT NULL,
	"title" text NOT NULL,
	"artist_credit" text NOT NULL,
	"norm_title" text NOT NULL,
	"norm_artist" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "track_aliases_unique" UNIQUE("track_id","norm_title","norm_artist")
);
--> statement-breakpoint
CREATE TABLE "track_artists" (
	"track_id" integer NOT NULL,
	"artist_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"credited_name" text,
	"join_phrase" text,
	CONSTRAINT "track_artists_track_id_artist_id_position_pk" PRIMARY KEY("track_id","artist_id","position")
);
--> statement-breakpoint
CREATE TABLE "track_contributors" (
	"track_id" integer NOT NULL,
	"contributor_name" text NOT NULL,
	"artist_id" integer,
	"role" text NOT NULL,
	"credited_name" text,
	"position" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"confidence" real,
	CONSTRAINT "track_contributors_track_id_contributor_name_role_position_pk" PRIMARY KEY("track_id","contributor_name","role","position"),
	CONSTRAINT "track_contributors_confidence_range" CHECK ("track_contributors"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "track_identifiers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "track_identifiers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"track_id" integer NOT NULL,
	"namespace" "identifier_namespace" NOT NULL,
	"identifier" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "track_identifiers_unique" UNIQUE("track_id","namespace","identifier")
);
--> statement-breakpoint
CREATE TABLE "track_lineage_disclosures" (
	"track_id" integer PRIMARY KEY NOT NULL,
	"classification" "lineage_classification" NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"evidence_text" text,
	"confidence" real,
	CONSTRAINT "track_lineage_disclosures_confidence_range" CHECK ("track_lineage_disclosures"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "track_name_aliases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "track_name_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"track_id" integer NOT NULL,
	"name" text NOT NULL,
	"locale" text,
	"alias_type" text,
	"is_primary" boolean,
	"source" text NOT NULL,
	CONSTRAINT "track_name_aliases_unique" UNIQUE("track_id","name","locale","alias_type")
);
--> statement-breakpoint
CREATE TABLE "track_works" (
	"track_id" integer NOT NULL,
	"work_id" integer NOT NULL,
	"relationship_type" text DEFAULT 'performance' NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "track_works_track_id_work_id_relationship_type_pk" PRIMARY KEY("track_id","work_id","relationship_type")
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tracks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"canonical_id" text NOT NULL,
	"identity_key" text NOT NULL,
	"kind" "track_kind" DEFAULT 'song' NOT NULL,
	"title" text NOT NULL,
	"artist_credit" text NOT NULL,
	"norm_title" text NOT NULL,
	"norm_artist" text NOT NULL,
	"release_year" smallint,
	"duration_ms" integer,
	"disambiguation" text,
	"is_video" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracks_canonical_id_unique" UNIQUE("canonical_id"),
	CONSTRAINT "tracks_identity_key_unique" UNIQUE("identity_key"),
	CONSTRAINT "tracks_duration_ms_positive" CHECK ("tracks"."duration_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_identifiers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "work_identifiers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"work_id" integer NOT NULL,
	"namespace" "identifier_namespace" NOT NULL,
	"identifier" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "work_identifiers_unique" UNIQUE("work_id","namespace","identifier")
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "works_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"canonical_id" text NOT NULL,
	"musicbrainz_work_id" text,
	"title" text NOT NULL,
	"work_type" text,
	"disambiguation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "works_canonical_id_unique" UNIQUE("canonical_id"),
	CONSTRAINT "works_musicbrainz_work_id_unique" UNIQUE("musicbrainz_work_id")
);
--> statement-breakpoint
ALTER TABLE "sample_assertions" ADD CONSTRAINT "sample_assertions_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_segments" ADD CONSTRAINT "sample_segments_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_parent_track_id_tracks_id_fk" FOREIGN KEY ("parent_track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_child_track_id_tracks_id_fk" FOREIGN KEY ("child_track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_aliases" ADD CONSTRAINT "track_aliases_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_contributors" ADD CONSTRAINT "track_contributors_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_contributors" ADD CONSTRAINT "track_contributors_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_identifiers" ADD CONSTRAINT "track_identifiers_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_lineage_disclosures" ADD CONSTRAINT "track_lineage_disclosures_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_name_aliases" ADD CONSTRAINT "track_name_aliases_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_works" ADD CONSTRAINT "track_works_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_works" ADD CONSTRAINT "track_works_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_identifiers" ADD CONSTRAINT "work_identifiers_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "samples_child_idx" ON "samples" USING btree ("child_track_id","relationship_type");--> statement-breakpoint
CREATE INDEX "samples_status_idx" ON "samples" USING btree ("status");--> statement-breakpoint
CREATE INDEX "track_aliases_norm_idx" ON "track_aliases" USING btree ("norm_title","norm_artist");--> statement-breakpoint
CREATE INDEX "track_artists_artist_id_idx" ON "track_artists" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "track_contributors_artist_id_idx" ON "track_contributors" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "track_identifiers_lookup_idx" ON "track_identifiers" USING btree ("namespace","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "track_identifiers_musicbrainz_unique" ON "track_identifiers" USING btree ("namespace","identifier") WHERE "track_identifiers"."namespace" = 'musicbrainz_recording';--> statement-breakpoint
CREATE INDEX "track_name_aliases_name_idx" ON "track_name_aliases" USING btree ("name");--> statement-breakpoint
CREATE INDEX "track_works_work_id_idx" ON "track_works" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "tracks_norm_idx" ON "tracks" USING btree ("norm_title","norm_artist","kind");--> statement-breakpoint
CREATE INDEX "work_identifiers_lookup_idx" ON "work_identifiers" USING btree ("namespace","identifier");