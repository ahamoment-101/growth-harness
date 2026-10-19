-- One native conversation per durable task. Execution ownership stays on agent_tasks.
alter table agent_tasks add column conversation_version integer not null default 0 check(conversation_version in (0,1));

create table agent_conversations (
  task_id text primary key references agent_tasks(id),
  protocol_version integer not null default 1 check(protocol_version = 1),
  instructions text not null,
  context_json text not null,
  created_at text not null
);

create table agent_conversation_messages (
  task_id text not null references agent_conversations(task_id),
  sequence integer not null check(sequence >= 1),
  message_key text not null,
  role text not null check(role in ('user','assistant','toolResult')),
  message_json text not null,
  created_at text not null,
  primary key(task_id,sequence),
  unique(task_id,message_key)
);

create table agent_conversation_calls (
  task_id text not null references agent_conversations(task_id),
  call_id text not null,
  assistant_sequence integer not null,
  call_index integer not null check(call_index >= 0),
  tool_name text not null,
  operation_id text references agent_task_operations(id),
  result_sequence integer,
  primary key(task_id,call_id),
  unique(task_id,assistant_sequence,call_index),
  unique(operation_id),
  foreign key(task_id,assistant_sequence) references agent_conversation_messages(task_id,sequence),
  foreign key(task_id,result_sequence) references agent_conversation_messages(task_id,sequence)
);
