-- Research-owned history, committed atomically with each notebook mutation.
CREATE TABLE research_notebook_versions (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, revision)
);
CREATE TRIGGER research_notebook_history AFTER UPDATE OF workspace_json, revision ON agent_tasks
WHEN NEW.agent_id = 'deep_research' AND NEW.revision <> OLD.revision
BEGIN
  INSERT OR IGNORE INTO research_notebook_versions VALUES (OLD.id, OLD.revision, OLD.workspace_json, OLD.updated_at);
  INSERT INTO research_notebook_versions VALUES (NEW.id, NEW.revision, NEW.workspace_json, NEW.updated_at);
END;
