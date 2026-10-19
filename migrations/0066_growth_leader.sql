-- Product metadata only: the existing Task/Run owns the conversation transcript.
create table leader_conversations (
  id text primary key,
  workspace_id text not null,
  site_id text not null references sites(id),
  title text not null,
  context text not null default '',
  source_id text not null default '',
  created_at text not null
);
create index leader_conversations_site on leader_conversations(workspace_id,site_id,created_at);
-- Delivery identity survives process exits; original payloads are immutable.
create table leader_inputs (
  position integer primary key autoincrement,
  id text not null unique,
  conversation_id text not null references leader_conversations(id),
  kind text not null check(kind in ('user','child_report','assignment')),
  actor_id text not null,
  content text not null,
  created_at text not null
);
create index leader_inputs_conversation on leader_inputs(conversation_id,created_at,id);
