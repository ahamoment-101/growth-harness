-- Historical public URLs belong to the same article through edits and revisions.
ALTER TABLE jobs ADD COLUMN url_aliases_json TEXT NOT NULL DEFAULT '[]';

-- Preserve history even for lifecycle writes that do not use the application edit helper.
CREATE TRIGGER jobs_preserve_public_urls AFTER UPDATE OF versions_json ON jobs
WHEN OLD.published_at IS NOT NULL AND OLD.versions_json <> NEW.versions_json
BEGIN
  UPDATE jobs SET url_aliases_json = (
    SELECT json_group_array(json_object('locale', locale, 'slug', slug)) FROM (
      SELECT json_extract(value, '$.locale') AS locale, json_extract(value, '$.slug') AS slug
      FROM json_each(NEW.url_aliases_json)
      UNION
      SELECT json_extract(value, '$.locale'), json_extract(value, '$.slug') FROM json_each(OLD.url_aliases_json)
      UNION
      SELECT json_extract(value, '$.locale'), json_extract(value, '$.slug')
      FROM json_each(OLD.versions_json)
      WHERE json_extract(value, '$.slug') <> ''
    )
  ) WHERE id = NEW.id;
END;

-- A URL has one owner within a site and language. SQLite serializes the check
-- and write, including simultaneous imports, publication and slug edits.
CREATE TRIGGER jobs_unique_public_url_insert BEFORE INSERT ON jobs
BEGIN
  SELECT RAISE(ABORT, 'article URL is already reserved') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.versions_json) candidate, jobs other,
      json_each(other.versions_json) existing
    WHERE other.site_id = NEW.site_id AND other.id <> NEW.id
      AND json_extract(candidate.value, '$.slug') <> ''
      AND json_extract(candidate.value, '$.locale') = json_extract(existing.value, '$.locale')
      AND json_extract(candidate.value, '$.slug') = json_extract(existing.value, '$.slug')
    UNION ALL
    SELECT 1 FROM json_each(NEW.versions_json) candidate, jobs other, json_each(other.url_aliases_json) existing
    WHERE other.site_id = NEW.site_id AND other.id <> NEW.id
      AND json_extract(candidate.value, '$.locale') = json_extract(existing.value, '$.locale')
      AND json_extract(candidate.value, '$.slug') = json_extract(existing.value, '$.slug')
  );
END;

CREATE TRIGGER jobs_unique_public_url_update BEFORE UPDATE OF versions_json, site_id ON jobs
WHEN NEW.versions_json <> OLD.versions_json OR NEW.site_id <> OLD.site_id
BEGIN
  SELECT RAISE(ABORT, 'article URL is already reserved') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.versions_json) candidate, jobs other, json_each(other.versions_json) existing
    WHERE other.site_id = NEW.site_id AND other.id <> NEW.id
      AND json_extract(candidate.value, '$.slug') <> ''
      AND json_extract(candidate.value, '$.locale') = json_extract(existing.value, '$.locale')
      AND json_extract(candidate.value, '$.slug') = json_extract(existing.value, '$.slug')
    UNION ALL
    SELECT 1 FROM json_each(NEW.versions_json) candidate, jobs other, json_each(other.url_aliases_json) existing
    WHERE other.site_id = NEW.site_id AND other.id <> NEW.id
      AND json_extract(candidate.value, '$.locale') = json_extract(existing.value, '$.locale')
      AND json_extract(candidate.value, '$.slug') = json_extract(existing.value, '$.slug')
  );
END;
