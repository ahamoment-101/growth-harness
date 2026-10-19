// Real isolated D1 cost probe. No production data, model calls or persistent storage.
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
  import { readSiteLedger } from './worker/site-ledger';
  function measured(db, stats) {
    const record = r => { stats.statements++; stats.rows_read += r.meta?.rows_read || 0; stats.rows_written += r.meta?.rows_written || 0; stats.sql_ms += r.meta?.duration || 0; return r; };
    const wrap = raw => ({ raw, bind(...args) { return wrap(raw.bind(...args)); },
      async all() { return record(await raw.all()); }, async run() { return record(await raw.run()); },
      async first(column) { const r=record(await raw.all()); const row=r.results[0] || null; return column ? row?.[column] ?? null : row; }
    });
    return { prepare(sql) { return wrap(db.prepare(sql)); }, async batch(statements) { return (await db.batch(statements.map(s=>s.raw))).map(record); } };
  }
  export default { async fetch(request, env, ctx) {
    const stats={statements:0,rows_read:0,rows_written:0,sql_ms:0};
    const data=await readSiteLedger({db:measured(env.DB,stats),workspaceId:'primary-workspace',siteId:'s'}, {waitUntil:p=>ctx.waitUntil(p)});
    return Response.json({data,stats});
  }};
` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-18', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], outboundService: () => new Response('disabled', {status:503}) }));
try {
  const db = await mf.getD1Database('DB');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(name,dir),'utf8')).replace(/'(?:''|[^'])*'|--[^\n]*/g,p=>p.startsWith('--')?'':p).replace(/\n/g,' '));
  }
  await db.prepare("insert into sites(id,name,ingest_url) values('s','Performance fixture','https://fixture.invalid')").run();
  // URL-integrity triggers scan existing articles during insert. Suspend only in this disposable
  // seed phase, then restore verbatim before measuring unchanged read queries.
  const triggers=(await db.prepare("select name,sql from sqlite_master where type='trigger' and tbl_name='jobs'").all()).results;
  for (const trigger of triggers) await db.exec('drop trigger "'+trigger.name.replaceAll('"','""')+'"');
  await db.prepare(`with recursive n(x) as (select 1 union all select x+1 from n where x<10000)
    insert into jobs(id,site_id,status,visibility,published_at,versions_json)
    select 'j'||x,'s','published',case when x%10=0 then 'hidden' else 'visible' end,'2026-09-19T01:00:00Z',
    json_array(json_object('locale','en','slug','a-'||x,'title','Example','content','Saved content'),json_object('locale','pt-BR','slug','b-'||x,'title','Example','content','Saved content')) from n`).run();
  await db.prepare(`with recursive n(x) as (select 1 union all select x+1 from n where x<20000)
    insert into keyword_library_entries(id,workspace_id,site_id,locale,market,kind,name,normalized_name,data_json,revision,archived,created_at,updated_at)
    select 'k'||x,'primary-workspace','s','en','US','keyword','keyword '||x,'keyword '||x,'{}',1,case when x%10=0 then 1 else 0 end,'2026-09-19T01:00:00Z','2026-09-19T01:00:00Z' from n`).run();
  for (const trigger of triggers) await db.exec(trigger.sql.replace(/\n/g,' '));
  for (const phase of ['cold','warm','warm_repeat']) {
    const result=await (await mf.dispatchFetch('http://fixture.invalid/ledger')).json();
    assert.equal(result.data.snapshot.published.total,9000);
    assert.equal(result.data.snapshot.keywords.total,18000);
    assert.equal(result.data.snapshot.languages,2);
    if (phase!=='cold') { assert.equal(result.stats.statements,1); assert.equal(result.stats.rows_read,1); }
    console.log(JSON.stringify({phase,...result.stats,published:result.data.snapshot.published.total,keywords:result.data.snapshot.keywords.total}));
  }
} finally { await mf.dispose(); }
