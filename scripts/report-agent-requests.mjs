// Read-only report. Application observations are not Cloudflare's internal meter.
// node scripts/report-agent-requests.mjs <run-id> --local|--remote [--config path] [--database name] [--env name]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWrangler } from './configuration.ts';
import { configuredD1Target, parseD1Options } from './d1-target.mjs';
const id = process.argv[2];
if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('A valid Run ID is required');
const options = parseD1Options(process.argv.slice(3));
const target = configuredD1Target(readWrangler(options.configPath), options);
const query = `select run_id,count(*) samples,sum(fetch_calls) observed_fetch,sum(d1_calls) observed_d1_round_trips,
 sum(sql_statements) observed_sql_statements,sum(r2_calls) observed_r2,sum(case when complete=0 then 1 else 0 end) incomplete_segments
 from agent_request_samples where run_id='${id}' group by run_id;
 select status,error_kind,count(*) attempts,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens
 from agent_model_attempts where run_id='${id}' group by status,error_kind;
 select t.id,t.status,t.revision,t.model_calls,t.reserved_tokens,t.external_calls from agent_tasks t
 join agent_task_runs r on r.task_id=t.id where r.run_id='${id}';
 select o.status,json_extract(o.action_json,'$.name') tool,count(*) operations from agent_task_operations o
 join agent_task_runs r on r.task_id=o.task_id where r.run_id='${id}' group by o.status,tool;
 select sum(provider_attempts) provider_attempts,sum(structural_repairs) structural_repairs,count(*) decisions,
 sum(case when structural_repairs is null then 1 else 0 end) unknown_repair_metrics from agent_decision_results where run_id='${id}';
 select count(*) recoveries from agent_task_recoveries where task_id in(select task_id from agent_task_runs where run_id='${id}');`;
const data = JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),'d1','execute',...target,'--json','--command',query],{encoding:'utf8'}));
console.log(JSON.stringify({run_id:id,measurement:'application_visible_partial',note:'Missing samples are unknown, not zero. D1 totals count round trips, not billed rows. SQL exec calls are counted as one submitted SQL unit.',
 sections:data.map(result=>result.results)},null,2));
