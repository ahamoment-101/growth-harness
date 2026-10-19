-- Remove the redundant market partition. Existing locale is retained verbatim; no aliases or language inference.

-- Colliding names/operation IDs abort this migration atomically; no record is silently merged or discarded.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE _language_preserve_keyword_library_entries AS SELECT * FROM keyword_library_entries;

CREATE TABLE _language_preserve_keyword_library_logs AS SELECT * FROM keyword_library_logs;

CREATE TABLE _language_preserve_keyword_library_memberships AS SELECT * FROM keyword_library_memberships;

CREATE TABLE _language_preserve_keyword_library_topic_links AS SELECT * FROM keyword_library_topic_links;

DROP TRIGGER keyword_library_logs_immutable_update;

DROP TRIGGER keyword_library_logs_immutable_delete;

DROP TABLE keyword_library_entries;

DROP TABLE keyword_library_logs;

DROP TABLE keyword_library_memberships;

DROP TABLE keyword_library_topic_links;

CREATE TABLE keyword_library_entries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('keyword', 'topic_group', 'cluster')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id, site_id) REFERENCES sites(workspace_id, id),
  UNIQUE(workspace_id, site_id, locale, kind, normalized_name),
  UNIQUE(id, workspace_id, site_id, locale, kind)
);

CREATE TABLE keyword_library_logs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
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
  UNIQUE(workspace_id,site_id,locale,operation_id)
);

CREATE TABLE keyword_library_memberships (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  parent_kind TEXT NOT NULL,
  child_kind TEXT NOT NULL,
  PRIMARY KEY(parent_id,child_id),
  CHECK((parent_kind='topic_group' AND child_kind IN ('cluster','keyword')) OR (parent_kind='cluster' AND child_kind='keyword')),
  FOREIGN KEY(parent_id,workspace_id,site_id,locale,parent_kind)
    REFERENCES keyword_library_entries(id,workspace_id,site_id,locale,kind),
  FOREIGN KEY(child_id,workspace_id,site_id,locale,child_kind)
    REFERENCES keyword_library_entries(id,workspace_id,site_id,locale,kind)
);

CREATE TABLE keyword_library_topic_links (
  keyword_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'keyword' CHECK(kind='keyword'),
  relationship TEXT NOT NULL,
  PRIMARY KEY(keyword_id,topic_id),
  FOREIGN KEY(keyword_id,workspace_id,site_id,locale,kind)
    REFERENCES keyword_library_entries(id,workspace_id,site_id,locale,kind),
  FOREIGN KEY(site_id,topic_id) REFERENCES topics(site_id,id)
);

INSERT INTO keyword_library_entries(id,workspace_id,site_id,locale,kind,name,normalized_name,data_json,revision,archived,created_at,updated_at) SELECT id,workspace_id,site_id,locale,kind,name,normalized_name,data_json,revision,archived,created_at,updated_at FROM _language_preserve_keyword_library_entries;

INSERT INTO keyword_library_logs(id,workspace_id,site_id,locale,operation_id,request_json,actor_json,action,target_id,before_json,after_json,changes_json,receipt_json,reason,created_at) SELECT id,workspace_id,site_id,locale,operation_id,request_json,actor_json,action,target_id,before_json,after_json,changes_json,receipt_json,reason,created_at FROM _language_preserve_keyword_library_logs;

INSERT INTO keyword_library_memberships(parent_id,child_id,workspace_id,site_id,locale,parent_kind,child_kind) SELECT parent_id,child_id,workspace_id,site_id,locale,parent_kind,child_kind FROM _language_preserve_keyword_library_memberships;

INSERT INTO keyword_library_topic_links(keyword_id,topic_id,workspace_id,site_id,locale,kind,relationship) SELECT keyword_id,topic_id,workspace_id,site_id,locale,kind,relationship FROM _language_preserve_keyword_library_topic_links;

CREATE INDEX keyword_library_entries_listing ON keyword_library_entries(workspace_id,site_id,locale,kind,id);

CREATE INDEX keyword_library_ledger on keyword_library_entries(workspace_id, site_id, kind, archived, created_at);

CREATE INDEX keyword_library_entries_locale_count on keyword_library_entries(site_id,locale,kind,archived);

CREATE INDEX keyword_library_logs_listing ON keyword_library_logs(workspace_id,site_id,locale,created_at,id);

CREATE INDEX keyword_library_logs_target ON keyword_library_logs(target_id,created_at,id);

CREATE TRIGGER keyword_library_logs_immutable_update BEFORE UPDATE ON keyword_library_logs
BEGIN SELECT RAISE(ABORT, 'keyword_library_logs_are_immutable'); END;

CREATE TRIGGER keyword_library_logs_immutable_delete BEFORE DELETE ON keyword_library_logs
BEGIN SELECT RAISE(ABORT, 'keyword_library_logs_are_immutable'); END;

CREATE INDEX keyword_library_memberships_child ON keyword_library_memberships(child_id,parent_id);

CREATE INDEX keyword_library_topic_links_topic ON keyword_library_topic_links(topic_id,keyword_id);

DROP TABLE _language_preserve_keyword_library_entries;

DROP TABLE _language_preserve_keyword_library_logs;

DROP TABLE _language_preserve_keyword_library_memberships;

DROP TABLE _language_preserve_keyword_library_topic_links;

PRAGMA defer_foreign_keys = OFF;
