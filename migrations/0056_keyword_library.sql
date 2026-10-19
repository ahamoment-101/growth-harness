-- Independent, market-scoped library. Historical strategy snapshots remain unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS sites_workspace_identity ON sites(workspace_id, id);
CREATE TABLE keyword_library_entries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  market TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('keyword', 'topic_group', 'cluster')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, site_id) REFERENCES sites(workspace_id, id),
  UNIQUE(workspace_id, site_id, locale, market, kind, normalized_name),
  UNIQUE(id, workspace_id, site_id, locale, market, kind)
);
CREATE INDEX keyword_library_entries_listing ON keyword_library_entries(workspace_id,site_id,locale,market,kind,id);
-- Named relationships, not untyped labels. A keyword may be ungrouped or appear in several clusters.
CREATE TABLE keyword_library_memberships (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  market TEXT NOT NULL,
  parent_kind TEXT NOT NULL,
  child_kind TEXT NOT NULL,
  PRIMARY KEY(parent_id,child_id),
  CHECK((parent_kind='topic_group' AND child_kind IN ('cluster','keyword')) OR (parent_kind='cluster' AND child_kind='keyword')),
  FOREIGN KEY(parent_id,workspace_id,site_id,locale,market,parent_kind)
    REFERENCES keyword_library_entries(id,workspace_id,site_id,locale,market,kind),
  FOREIGN KEY(child_id,workspace_id,site_id,locale,market,child_kind)
    REFERENCES keyword_library_entries(id,workspace_id,site_id,locale,market,kind)
);
CREATE INDEX keyword_library_memberships_child ON keyword_library_memberships(child_id,parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS topics_site_identity ON topics(site_id,id);
CREATE TABLE keyword_library_topic_links (
  keyword_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  market TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'keyword' CHECK(kind='keyword'),
  relationship TEXT NOT NULL,
  PRIMARY KEY(keyword_id,topic_id),
  FOREIGN KEY(keyword_id,workspace_id,site_id,locale,market,kind)
    REFERENCES keyword_library_entries(id,workspace_id,site_id,locale,market,kind),
  FOREIGN KEY(site_id,topic_id) REFERENCES topics(site_id,id)
);
CREATE INDEX keyword_library_topic_links_topic ON keyword_library_topic_links(topic_id,keyword_id);
CREATE TABLE keyword_library_logs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  market TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, site_id) REFERENCES sites(workspace_id,id),
  UNIQUE(workspace_id,site_id,locale,market,operation_id)
);
CREATE INDEX keyword_library_logs_listing ON keyword_library_logs(workspace_id,site_id,locale,market,created_at,id);
CREATE INDEX keyword_library_logs_target ON keyword_library_logs(target_id,created_at,id);
CREATE TRIGGER keyword_library_logs_immutable_update BEFORE UPDATE ON keyword_library_logs
BEGIN SELECT RAISE(ABORT, 'keyword_library_logs_are_immutable'); END;
CREATE TRIGGER keyword_library_logs_immutable_delete BEFORE DELETE ON keyword_library_logs
BEGIN SELECT RAISE(ABORT, 'keyword_library_logs_are_immutable'); END;
