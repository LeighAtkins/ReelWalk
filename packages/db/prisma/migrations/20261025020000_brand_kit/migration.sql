-- ADR 0078: a workspace's brand kit (fonts, palette, named text styles), JSON validated in the app. Additive; null for every existing workspace.
ALTER TABLE "Workspace" ADD COLUMN "brandKit" JSONB;
