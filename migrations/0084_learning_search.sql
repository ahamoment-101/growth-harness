-- The search projection is a derivative, never the authoritative experience.
-- Keep this projection version and worker/learning/search.ts together when changing models.
create view learning_search_documents as
select id,workspace_id,site_id,json_object(
 'title',title,
 'goal',json_extract(data_json,'$.intent.goal'),
 'context',json_extract(data_json,'$.intent.context'),
 'expectation',json_extract(data_json,'$.intent.expectation'),
 'hypothesis',json_extract(data_json,'$.experience.hypothesis'),
 'approach',json_extract(data_json,'$.experience.approach'),
 'adjustments',json_extract(data_json,'$.experience.adjustments'),
 'delivery',json_extract(data_json,'$.experience.delivery'),
 'insight',json_extract(data_json,'$.experience.insight'),
 'conclusion',json_extract(data_json,'$.experience.assessment.conclusion'),
 'limitations',json_extract(data_json,'$.experience.assessment.limitations'),
 'gaps',json_extract(data_json,'$.experience.gaps')
) as document_json from learning_records;

create table learning_search_sources (
 record_id text primary key,workspace_id text not null,site_id text not null,
 generation integer not null,document_json text not null
);
create index learning_search_sources_scope on learning_search_sources(workspace_id,site_id,record_id);
create table learning_search_jobs (
 record_id text not null,generation integer not null,
 workspace_id text not null,site_id text not null,document_json text not null,
 profile text not null default 'bge-m3-1024-projection-v1',
 state text not null default 'pending' check(state in ('pending','confirming','ready','blocked','retiring','deleted')),
 vector_id text not null default '',content_hash text not null default '',
 mutation_id text not null default '',attempts integer not null default 0,
 error text not null default '',available_at text not null,
 lease_token text not null default '',lease_until text not null default '',
 primary key(record_id,generation)
);
create index learning_search_jobs_due on learning_search_jobs(state,available_at,record_id,generation);
create index learning_search_jobs_scope on learning_search_jobs(workspace_id,site_id,state);
create unique index learning_search_jobs_vector on learning_search_jobs(vector_id) where vector_id!='';

create trigger learning_search_enqueue after insert on learning_search_sources begin
 insert into learning_search_jobs(record_id,generation,workspace_id,site_id,document_json,available_at)
 values(new.record_id,new.generation,new.workspace_id,new.site_id,new.document_json,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
end;
create trigger learning_search_revise after update on learning_search_sources begin
 update learning_search_jobs set state='retiring',available_at=max(lease_until,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 where record_id=new.record_id and state not in ('retiring','deleted');
 insert into learning_search_jobs(record_id,generation,workspace_id,site_id,document_json,available_at)
 values(new.record_id,new.generation,new.workspace_id,new.site_id,new.document_json,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
end;
create trigger learning_search_insert after insert on learning_records begin
 insert into learning_search_sources select id,workspace_id,site_id,1,document_json from learning_search_documents where id=new.id;
end;
create trigger learning_search_update after update of title,data_json on learning_records begin
 update learning_search_sources set generation=generation+1,
 document_json=(select document_json from learning_search_documents where id=new.id)
 where record_id=new.id and document_json!=(select document_json from learning_search_documents where id=new.id);
end;
create trigger learning_search_delete after delete on learning_records begin
 delete from learning_search_sources where record_id=old.id;
 update learning_search_jobs set state='retiring',available_at=max(lease_until,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 where record_id=old.id and state not in ('retiring','deleted');
end;
-- A one-time historical backfill. The minute worker only reads the due index.
insert into learning_search_sources select id,workspace_id,site_id,1,document_json from learning_search_documents;
