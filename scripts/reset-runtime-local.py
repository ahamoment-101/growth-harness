#!/usr/bin/env python3
"""Local-only Runtime reset. Stops if a process still holds local persistence files."""
import argparse, hashlib, json, pathlib, shutil, sqlite3, subprocess, tempfile

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--local', action='store_true', required=True)
parser.add_argument('--confirm-reset-runtime', action='store_true', required=True)
parser.parse_args()
state = root / '.wrangler/state/v3'
paths = [p for p in (state / 'd1').rglob('*.sqlite') if p.name != 'metadata.sqlite']
if len(paths) != 1:
    raise SystemExit('Expected exactly one local D1 application database')
opened = subprocess.run(['lsof', '-t', '+D', str(state)], capture_output=True, text=True)
if opened.stdout.strip():
    raise SystemExit('Stop local Vite/Worker/Workflow processes before resetting persistence')
backup = pathlib.Path(tempfile.mkdtemp(prefix='blog-runtime-reset-'))
db = sqlite3.connect(paths[0])
db.execute('pragma foreign_keys=on')
with sqlite3.connect(backup / 'application.sqlite') as copy:
    db.backup(copy)

def tables():
    return [r[0] for r in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
def is_runtime(name):
    return (name.startswith('agent_') and name != 'agent_memories') or name in ('seo_strategy_runs','firecrawl_research_jobs','research_sources','research_source_indexes','research_notebook_versions')
def snapshot():
    report = {}
    for name in tables():
        if is_runtime(name) or name == 'd1_migrations': continue
        columns = [r[1] for r in db.execute(f'pragma table_info("{name}")') if r[1] != 'submission_operation_id']
        query = 'select ' + ','.join('"'+c+'"' for c in columns) + f' from "{name}"'
        rows = sorted(json.dumps(list(row), ensure_ascii=False, default=str) for row in db.execute(query))
        report[name] = {'count': len(rows), 'sha256': hashlib.sha256('\n'.join(rows).encode()).hexdigest()}
    return report
before = snapshot()
# Run only repository migrations not yet applied, against this resolved local file.
applied = {r[0] for r in db.execute('select name from d1_migrations')}
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration.name in applied: continue
    try:
        db.executescript('begin;\n'+migration.read_text()+"\ninsert into d1_migrations(name) values('"+migration.name+"');\ncommit;")
    except Exception:
        db.rollback(); raise
if snapshot() != before:
    raise SystemExit(f'Migration changed protected data; backup at {backup}')
# Explicit local cleanup; no data deletion belongs in a schema migration.
with db:
    db.execute('begin')
    db.execute('pragma defer_foreign_keys=on')
    for name in tables():
        if is_runtime(name): db.execute(f'delete from "{name}"')
if list(db.execute('pragma foreign_key_check')):
    raise SystemExit('Foreign key violation after Runtime reset')
after = snapshot()
if after != before:
    raise SystemExit(f'Protected data changed; backup at {backup}')
db.close()
# Old Workflow/AgentShell SQLite state cannot replay into the cleaned database.
carriers = list((state / 'workflows').glob('*')) if (state / 'workflows').exists() else []
carriers += [p for p in (state / 'do').glob('*') if p.name.endswith(('-AgentShell','-AgentRuntimeProbe'))]
for path in carriers:
    shutil.move(str(path), str(backup / path.name))
report = {'scope':'local_only','backup':str(backup),'protected_data_unchanged':True,'tables':after}
(backup / 'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'scope':'local_only','backup':str(backup),'protected_tables':len(after),'protected_data_unchanged':True},ensure_ascii=False))
