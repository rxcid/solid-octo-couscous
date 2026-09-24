-- The first import deliberately omitted graph_nodes.cluster_id: name/ISRC
-- grouping sufficed for one-hop Music DNA. Generations now walks version
-- clusters across handoffs, so this column restores Sinc's grouping.
-- Preserve graph_nodes.id as catalog_node_id too. An unclustered node stands
-- alone with key -catalog_node_id, even if Postgres join ids change.
ALTER TABLE "tracks" ADD COLUMN "catalog_node_id" integer;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "cluster_id" integer;--> statement-breakpoint
CREATE INDEX "tracks_cluster_idx" ON "tracks" USING btree ("cluster_id");--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_catalog_node_id_unique" UNIQUE("catalog_node_id");