import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

// A new loopback-only cluster per run. Never accept a database URL, Supabase
// connection, service file or existing data directory from the environment.
const bin = process.env.WORLIBRARY_TEST_PG_BIN
assert.ok(bin, 'Set WORLIBRARY_TEST_PG_BIN to a local PostgreSQL bin directory; no remote database is used')
const suffix = process.platform === 'win32' ? '.exe' : ''
const root = resolve('test-results', 'private-file-postgres', randomUUID())
const data = join(root, 'data')
const clusterName = `worlibrary_files_${randomUUID().replaceAll('-', '')}`
let port
let started = false

function executable(name) { return join(bin, `${name}${suffix}`) }
function child(name, args, appName = 'private-file-fixture') {
  return spawn(executable(name), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key))),
    PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'worlibrary_test', PGDATABASE: 'postgres',
    PGPASSFILE: join(root, 'no-password'),
    PGSSLMODE: 'disable', PGAPPNAME: appName, PGCONNECT_TIMEOUT: '3',
  } })
}
function collect(process) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''
    process.stdout.on('data', (chunk) => { stdout += chunk })
    process.stderr.on('data', (chunk) => { stderr += chunk })
    process.on('error', reject)
    process.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr }))
  })
}
function errorSummary(result) { return result.stderr.match(/(?:ERROR|FATAL):[^\r\n]*/i)?.[0] ?? `process exit ${result.code}` }
async function tool(name, args) {
  const process = child(name, args); process.stdin.end()
  const result = await collect(process)
  assert.equal(result.code, 0, `${name}: ${errorSummary(result)}`)
  return result.stdout
}
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`
const claims = (user, anonymous = false) => `set request.jwt.claims = ${literal(JSON.stringify({ sub: user, is_anonymous: anonymous }))};`
function query(sql, { role, user, anonymous, appName } = {}) {
  const process = child('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], appName)
  const result = collect(process)
  process.stdin.end(`${role ? `set role ${role};` : ''}${user ? claims(user, anonymous) : ''}${sql}\n`)
  return result
}
async function ok(sql, options) {
  const result = await query(sql, options)
  assert.equal(result.code, 0, errorSummary(result))
  return result.stdout
}
async function denied(sql, options, pattern) {
  const result = await query(sql, options)
  assert.notEqual(result.code, 0, 'Expected the private-file operation to be rejected')
  if (pattern) assert.match(errorSummary(result), pattern)
}
function service(sql, appName) { return query(sql, { role: 'service_role', appName }) }
async function serviceOk(sql) { return ok(sql, { role: 'service_role' }) }
function beginSql(fixture, operation = fixture.operation, name = 'fixture.pdf') {
  return `select manifest_id from public.begin_user_file_upload('${fixture.user}', '${fixture.edition}', ${literal(name)}, 'application/pdf', 4, 8388608, 1, '${operation}', '${'a'.repeat(64)}');`
}
// Fixture receipts are synthetic: these tests prove SQL/CAS, not actual R2 bytes.
const completeSql = (fixture, generation = `((public.get_private_file_verification_snapshot('${fixture.user}', '${fixture.manifest}')->>'generation')::bigint)`) =>
  `select public.complete_verified_user_file_upload('${fixture.user}', '${fixture.manifest}', ${generation}, 4, '${'a'.repeat(64)}');`
const deleteSql = (fixture) => `select manifest_id from public.request_user_file_delete('${fixture.user}', '${fixture.manifest}');`
const finishSql = (fixture) => `select public.finish_user_file_delete('${fixture.user}', '${fixture.manifest}');`
function recordSql(fixture, size = 4) {
  const key = `private/${fixture.user}/${fixture.manifest}/v1/0`
  return `select public.record_user_file_chunk('${fixture.user}', '${fixture.manifest}', 0, '${'b'.repeat(64)}', ${size}, ${literal(key)});`
}
async function fixture({ manifest = true, chunk = true } = {}) {
  const result = { user: randomUUID(), edition: randomUUID(), operation: randomUUID() }
  await ok(`insert into auth.users values ('${result.user}'); insert into public.editions(id,user_id) values ('${result.edition}', '${result.user}');`)
  await ok('select public.set_private_file_library_enabled(true);', { role: 'authenticated', user: result.user })
  if (manifest) {
    result.manifest = await serviceOk(beginSql(result))
    if (chunk) await serviceOk(recordSql(result))
  }
  return result
}
async function quota(fixture) {
  return JSON.parse(await ok(`select json_build_object('used',used_bytes,'reserved',reserved_bytes) from public.user_storage_quotas where user_id='${fixture.user}';`))
}
async function hold(sql, options = {}) {
  const process = child('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], options.appName)
  let output = ''; let error = ''; let exited = false
  const waiters = new Map()
  process.stdout.on('data', (chunk) => {
    output += chunk
    for (const [marker, waiter] of waiters) if (output.includes(marker)) { waiters.delete(marker); waiter.resolve() }
  })
  process.stderr.on('data', (chunk) => { error += chunk })
  process.on('close', () => {
    exited = true
    for (const waiter of waiters.values()) waiter.reject(new Error(errorSummary({ stderr: error, code: 'holder exited' })))
    waiters.clear()
  })
  process.on('error', () => { exited = true; for (const waiter of waiters.values()) waiter.reject(new Error('transaction holder process failed')) })
  async function send(command) {
    const marker = `ready_${randomUUID().replaceAll('-', '')}`
    const ready = new Promise((resolve, reject) => waiters.set(marker, { resolve, reject }))
    process.stdin.write(`${command}\n\\echo ${marker}\n`)
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(exited ? 'transaction holder exited' : 'transaction holder timed out')), 10000)
    })
    try { await Promise.race([ready, timeout]) } finally { clearTimeout(timer); waiters.delete(marker) }
  }
  await send(`begin; ${options.role ? `set role ${options.role};` : ''}${options.user ? claims(options.user) : ''}${sql}`)
  return { send, close: async () => { if (!exited) { await send('rollback;'); process.stdin.end('\\q\n') } } }
}
async function blocked(appNames, event = 'advisory') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const count = Number(await ok(`select count(*) from pg_stat_activity where application_name in (${appNames.map(literal).join(',')}) and wait_event_type='Lock'${event ? ` and wait_event=${literal(event)}` : ''};`))
    if (count === appNames.length) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.fail('Expected the real PostgreSQL sessions to wait on the shared account advisory lock')
}

before(async () => {
  await mkdir(root, { recursive: true })
  port = await new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)) })
  })
  await tool('initdb', ['-D', data, '--auth=trust', '--username=worlibrary_test', '--encoding=UTF8', '--no-locale'])
  await tool('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -c cluster_name=${clusterName} -c max_connections=16 -c fsync=off`, '-w', 'start'])
  started = true
  assert.equal(await ok('show cluster_name;'), clusterName, 'Refuse to run fixture DDL on an unexpected PostgreSQL server')
  await ok(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table public.editions(id uuid primary key, user_id uuid references auth.users(id), deleted_at timestamptz);`)
  for (const migration of ['0014_private_user_file_library.sql', '0015_private_user_file_gateway.sql', '0017_private_user_file_storage_and_quota_fix.sql', '0018_private_file_consent.sql', '0019_private_file_lifecycle_serialization.sql', '0020_private_file_verification_snapshot.sql']) {
    await ok(await readFile(join('supabase/migrations', migration), 'utf8'))
  }
}, { timeout: 60000 })

after(async () => { if (started) await tool('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']) })

test('local SQL: stable own consent is narrow; anonymous and direct writes are denied', async () => {
  const f = await fixture()
  const other = randomUUID(); await ok(`insert into auth.users values ('${other}');`)
  const state = JSON.parse(await ok('select public.get_private_file_library_state();', { role: 'authenticated', user: other }))
  assert.equal(state.enabled, false); assert.equal(state.consented, false)
  assert.equal(await ok(`select count(*) from public.user_file_manifests where id='${f.manifest}';`, { role: 'authenticated', user: other }), '0')
  await denied('select public.get_private_file_library_state();', { role: 'authenticated', user: f.user, anonymous: true }, /stable account required/)
  await denied('select * from public.user_file_library_preferences;', { role: 'authenticated', user: f.user }, /permission denied/)
  await denied(beginSql(f), { role: 'authenticated', user: f.user }, /permission denied/)
  await denied(`select public.begin_user_file_upload('${other}','${f.edition}','fixture.pdf','application/pdf',4,8388608,1,'${randomUUID()}','${'a'.repeat(64)}');`, { role: 'service_role' }, /consent required|owned active edition/)
})

test('local SQL concurrency: committed pause rejects waiting begin, record and complete without new quota', async () => {
  const f = await fixture()
  const holder = await hold('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user })
  try {
    const names = [randomUUID(), randomUUID(), randomUUID()]
    const pending = [service(beginSql(f), names[0]), service(recordSql(f), names[1]), service(completeSql(f), names[2])]
    await blocked(names)
    await holder.send('commit;')
    for (const result of await Promise.all(pending)) { assert.notEqual(result.code, 0); assert.match(errorSummary(result), /consent required/) }
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    assert.equal(await ok(`select upload_state from public.user_file_manifests where id='${f.manifest}';`), 'uploading')
  } finally { await holder.close() }
})

test('local SQL concurrency: committed cloud deletion rejects old completion and reservation; finish is idempotent', async () => {
  const f = await fixture()
  const holder = await hold(deleteSql(f), { role: 'service_role' })
  try {
    const names = [randomUUID(), randomUUID()]
    const pending = [service(completeSql(f), names[0]), service(beginSql(f), names[1])]
    await blocked(names); await holder.send('commit;')
    for (const result of await Promise.all(pending)) { assert.notEqual(result.code, 0); assert.match(errorSummary(result), /tombstone|not verifiable/) }
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    await serviceOk(finishSql(f)); await serviceOk(finishSql(f))
    assert.deepEqual(await quota(f), { used: 0, reserved: 0 })
    await ok(`update public.user_file_tombstones set expires_at=now()-interval '31 days' where user_id='${f.user}';`)
    await denied(beginSql(f), { role: 'service_role' }, /tombstone/)
  } finally { await holder.close() }
})

test('local SQL concurrency: identical begin calls serialize and reserve exactly once', async () => {
  const f = await fixture({ manifest: false })
  const holder = await hold(beginSql(f), { role: 'service_role' })
  try {
    const name = randomUUID(); const pending = service(beginSql(f, randomUUID()), name)
    await blocked([name]); await holder.send('commit;')
    const result = await pending; assert.equal(result.code, 0, errorSummary(result))
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    assert.equal(await ok(`select count(*) from public.user_file_manifests where user_id='${f.user}';`), '1')
    await denied(beginSql(f, f.operation, 'different.pdf'), { role: 'service_role' }, /idempotency key conflict/)
  } finally { await holder.close() }
})

test('local SQL: paused accounts keep existing read/delete rights; used quota releases only after finish', async () => {
  const f = await fixture(); await serviceOk(completeSql(f)); await serviceOk(completeSql(f))
  assert.deepEqual(await quota(f), { used: 4, reserved: 0 })
  await ok('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user })
  assert.equal(await ok(`select count(*) from public.user_file_manifests where id='${f.manifest}';`, { role: 'authenticated', user: f.user }), '1')
  await denied(finishSql(f), { role: 'service_role' }, /deletion was not requested/)
  await serviceOk(deleteSql(f)); assert.deepEqual(await quota(f), { used: 4, reserved: 0 })
  await serviceOk(finishSql(f)); await serviceOk(finishSql(f)); assert.deepEqual(await quota(f), { used: 0, reserved: 0 })
})

test('local SQL: expiry cleanup retries pending deletion before allowing a renewed reservation', async () => {
  const f = await fixture()
  await ok(`update public.user_file_manifests set upload_expires_at=now()-interval '1 hour' where id='${f.manifest}';`)
  const reap = `select manifest_id from public.reap_expired_user_file_uploads('${f.user}');`
  assert.equal(await serviceOk(reap), f.manifest)
  assert.equal(await serviceOk(reap), f.manifest)
  await denied(beginSql(f), { role: 'service_role' }, /not active/)
  await serviceOk(finishSql(f)); assert.deepEqual(await quota(f), { used: 0, reserved: 0 })
  assert.equal(await serviceOk(beginSql(f)), f.manifest)
  assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
})

test('local SQL concurrency: an old repeatable-read snapshot cannot reserve after committed deletion', async () => {
  const f = await fixture()
  const holder = await hold(`set transaction isolation level repeatable read; select enabled from public.user_file_library_preferences where user_id='${f.user}';`, { role: 'service_role' })
  try {
    await serviceOk(deleteSql(f))
    const changedFile = beginSql(f, randomUUID()).replace('a'.repeat(64), 'c'.repeat(64))
    await assert.rejects(holder.send(changedFile), /could not serialize/)
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    assert.equal(await ok(`select count(*) from public.user_file_manifests where user_id='${f.user}';`), '1')
  } finally { await holder.close() }
})

test('local SQL: pause and re-enable retain the first explicit consent timestamp', async () => {
  const f = await fixture({ manifest: false })
  const timestamp = await ok(`select accepted_at::text from public.user_file_library_preferences where user_id='${f.user}';`)
  const paused = JSON.parse(await ok('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user }))
  assert.equal(paused.enabled, false); assert.equal(paused.consented, true)
  const resumed = JSON.parse(await ok('select public.set_private_file_library_enabled(true);', { role: 'authenticated', user: f.user }))
  assert.equal(resumed.enabled, true); assert.equal(resumed.consented, true)
  assert.equal(await ok(`select accepted_at::text from public.user_file_library_preferences where user_id='${f.user}';`), timestamp)
})

test('local SQL: record rejects incorrect size, key and owner, and expired completion cannot activate', async () => {
  const f = await fixture({ chunk: false })
  await denied(recordSql(f, 3), { role: 'service_role' }, /invalid chunk/)
  await denied(recordSql(f).replace('/v1/0', '/v1/1'), { role: 'service_role' }, /invalid chunk/)
  const other = await fixture({ manifest: false })
  await denied(recordSql({ ...f, user: other.user }), { role: 'service_role' }, /manifest not found/)
  assert.equal(await ok(`select count(*) from public.user_file_chunks where manifest_id='${f.manifest}';`), '0')
  await serviceOk(recordSql(f))
  await ok(`update public.user_file_manifests set upload_expires_at=now()-interval '1 hour' where id='${f.manifest}';`)
  await denied(recordSql(f), { role: 'service_role' }, /not active/)
  await denied(completeSql(f), { role: 'service_role' }, /not verifiable/)
  assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
})

test('local SQL concurrency: metadata deletion is rechecked after its row lock; file cleanup remains allowed', async () => {
  const f = await fixture()
  const holder = await hold(`update public.editions set deleted_at=now() where id='${f.edition}';`)
  try {
    const name = randomUUID(); const pending = service(completeSql(f), name)
    await blocked([name], null); await holder.send('commit;')
    const result = await pending; assert.notEqual(result.code, 0); assert.match(errorSummary(result), /owned active edition/)
    await denied(beginSql(f), { role: 'service_role' }, /owned active edition/)
    await denied(recordSql(f), { role: 'service_role' }, /owned active edition/)
    await serviceOk(deleteSql(f)); await serviceOk(finishSql(f))
    assert.deepEqual(await quota(f), { used: 0, reserved: 0 })
  } finally { await holder.close() }
})

const snapshotSql = (f) => `select public.get_private_file_verification_snapshot('${f.user}', '${f.manifest}');`
async function snapshot(f) { return JSON.parse(await serviceOk(snapshotSql(f))) }

test('local SQL verification: snapshot and completion are service-only and legacy completion is closed', async () => {
  const f = await fixture()
  for (const role of ['anon', 'authenticated']) {
    await denied(snapshotSql(f), { role, user: f.user }, /permission denied/)
    await denied(completeSql(f, '1'), { role, user: f.user }, /permission denied/)
  }
  await denied(`select public.complete_user_file_upload('${f.user}', '${f.manifest}');`, { role: 'service_role' }, /permission denied/)
  await denied(`select public.complete_user_file_upload('${f.user}', '${f.manifest}');`, {}, /verified completion required/)
  const other = await fixture({ manifest: false })
  await denied(snapshotSql({ ...f, user: other.user }), { role: 'service_role' }, /manifest not found/)
  await denied(completeSql({ ...f, user: other.user }, '1'), { role: 'service_role' }, /manifest not found/)
  const s = await snapshot(f)
  assert.deepEqual(Object.keys(s).sort(), ['chunks', 'generation', 'manifest'])
  assert.deepEqual(s.manifest, { size: 4, hash: 'a'.repeat(64), chunkSize: 8388608, chunkCount: 1 })
  assert.equal(s.chunks.length, 1); assert.equal(s.generation, 1)
  assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
})

test('local SQL verification: changed ledger invalidates prior snapshot; fresh receipt activates once', async () => {
  const f = await fixture(); const s = await snapshot(f)
  await serviceOk(recordSql(f))
  const next = await snapshot(f); assert.equal(next.generation, s.generation + 1)
  await denied(completeSql(f, s.generation), { role: 'service_role' }, /snapshot changed/)
  await denied(completeSql(f, 'null'), { role: 'service_role' }, /snapshot changed/)
  await denied(completeSql(f, next.generation).replace(', 4,', ', 3,'), { role: 'service_role' }, /descriptor mismatch/)
  await denied(completeSql(f, next.generation).replace('a'.repeat(64), 'c'.repeat(64)), { role: 'service_role' }, /descriptor mismatch/)
  assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
  const holder = await hold(completeSql(f, next.generation), { role: 'service_role' })
  try {
    const name = randomUUID(); const pending = service(completeSql(f, next.generation), name)
    await blocked([name]); await holder.send('commit;')
    const result = await pending; assert.equal(result.code, 0, errorSummary(result))
    assert.deepEqual(await quota(f), { used: 4, reserved: 0 })
    assert.equal(await ok(`select upload_state from public.user_file_manifests where id='${f.manifest}';`), 'active')
  } finally { await holder.close() }
})

test('local SQL verification concurrency: in-flight chunk commit invalidates a previously read snapshot', async () => {
  const f = await fixture(); const s = await snapshot(f)
  const holder = await hold(recordSql(f), { role: 'service_role' })
  try {
    const name = randomUUID(); const pending = service(completeSql(f, s.generation), name)
    await blocked([name]); await holder.send('commit;')
    const result = await pending; assert.notEqual(result.code, 0); assert.match(errorSummary(result), /snapshot changed/)
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
  } finally { await holder.close() }
})

test('local SQL verification: a saved snapshot cannot activate after pause, deletion, expiry or metadata deletion', async () => {
  for (const action of ['pause', 'delete', 'expire', 'metadata-delete']) {
    const f = await fixture(); const s = await snapshot(f)
    if (action === 'pause') await ok('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user })
    if (action === 'delete') await serviceOk(deleteSql(f))
    if (action === 'expire') await ok(`update public.user_file_manifests set upload_expires_at=now()-interval '1 hour' where id='${f.manifest}';`)
    if (action === 'metadata-delete') await ok(`update public.editions set deleted_at=now() where id='${f.edition}';`)
    await denied(completeSql(f, s.generation), { role: 'service_role' }, /consent|required|tombstone|not verifiable|owned active edition/)
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
  }
})

test('local SQL verification: incomplete or malformed current ledger cannot produce a snapshot', async () => {
  const f = await fixture({ chunk: false })
  await denied(snapshotSql(f), { role: 'service_role' }, /incomplete/)
  await serviceOk(recordSql(f)); const initial = await snapshot(f)
  await ok(`update public.user_file_chunks set ciphertext_size=3 where manifest_id='${f.manifest}';`)
  await denied(snapshotSql(f), { role: 'service_role' }, /incomplete/)
  await ok(`update public.user_file_chunks set ciphertext_size=4, chunk_index=2 where manifest_id='${f.manifest}';`)
  await denied(snapshotSql(f), { role: 'service_role' }, /incomplete/)
  await ok(`delete from public.user_file_chunks where manifest_id='${f.manifest}';`)
  assert.equal(await ok(`select chunk_generation from public.user_file_manifests where id='${f.manifest}';`), String(initial.generation + 3))
  await denied(snapshotSql(f), { role: 'service_role' }, /incomplete/)
})

test('0021 local SQL: intent cutover and deletion-fence protocol', async (t) => {
  const migration = await readFile('supabase/migrations/0021_private_file_write_intents.sql', 'utf8')
  // Previous tests deliberately left legacy fixture rows. Cutover must refuse
  // them without changing data; only this disposable, identity-checked cluster
  // is reset afterward. Never use this fixture reset against a real database.
  await denied(`begin; ${migration} commit;`, {}, /legacy private chunks/)
  assert.equal(await ok("select to_regclass('public.private_file_write_intents') is null;"), 't')
  await ok('delete from public.editions; delete from auth.users;')
  await ok(migration)
  await ok(await readFile('supabase/migrations/0022_private_file_cleanup_status.sql', 'utf8'))
  const prepare = (f, index = 0, size = 4, hash = 'b'.repeat(64)) => `select public.prepare_private_file_chunk('${f.user}','${f.manifest}',${index},'${hash}',${size});`
  const prepared = async (f, index = 0, size = 4) => JSON.parse(await serviceOk(prepare(f, index, size)))
  const commit = (f, i) => `select public.commit_private_file_chunk('${f.user}','${i.id}');`
  const cleanup = f => `select public.get_private_file_cleanup_intents('${f.user}','${f.manifest}');`
  const ack = (f, i) => `select public.ack_private_file_body_fence('${f.user}','${i.id}');`
  const fresh = () => fixture({ chunk: false })

  await t.test('durable intent is service-only, random, stable for identical retry and precedes ledger', async () => {
    const f = await fresh(); const i = await prepared(f)
    assert.match(i.id, /^[0-9a-f-]{36}$/); assert.equal(i.key, `private-intents/${i.id}`)
    assert.doesNotMatch(i.key, new RegExp(f.user)); assert.deepEqual(await prepared(f), i)
    assert.equal(await ok(`select count(*) from public.user_file_chunks where manifest_id='${f.manifest}';`), '0')
    await denied(prepare(f, 0, 3), { role: 'service_role' }, /invalid chunk/)
    await denied(prepare(f, 0, 4, 'c'.repeat(64)), { role: 'service_role' }, /intent conflict/)
    for (const role of ['anon', 'authenticated']) {
      await denied(prepare(f), { role, user: f.user }, /permission denied/)
      await denied(commit(f, i), { role, user: f.user }, /permission denied/)
      await denied(cleanup(f), { role, user: f.user }, /permission denied/)
      await denied(ack(f, i), { role, user: f.user }, /permission denied/)
    }
    await denied('select * from public.private_file_write_intents;', { role: 'service_role' }, /permission denied/)
    await denied(recordSql(f), { role: 'service_role' }, /permission denied/)
    const other = await fixture({ manifest: false })
    await denied(commit(other, i), { role: 'service_role' }, /intent not found/)
    await denied(ack(other, i), { role: 'service_role' }, /intent not found/)
    await serviceOk(commit(f, i)); await serviceOk(commit(f, i))
    assert.equal((await snapshot(f)).generation, 1)
  })

  await t.test('pause rejects new and old writes; deletion enumerates unconfirmed intents and gates quota release', async () => {
    const f = await fresh(); const i = await prepared(f)
    await ok('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user })
    await denied(prepare(f), { role: 'service_role' }, /consent required/)
    await denied(commit(f, i), { role: 'service_role' }, /consent required/)
    await serviceOk(deleteSql(f))
    assert.deepEqual(JSON.parse(await serviceOk(cleanup(f))), [{ id: i.id, key: i.key }])
    await denied(finishSql(f), { role: 'service_role' }, /cleanup is incomplete/)
    assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    // Synthetic service ack only; actual R2 fence is tested in workerd.
    await serviceOk(ack(f, i)); await serviceOk(ack(f, i)); await serviceOk(finishSql(f)); await serviceOk(finishSql(f))
    assert.deepEqual(await quota(f), { used: 0, reserved: 0 })
    await denied(commit(f, i), { role: 'service_role' }, /consent|required|tombstone/)
  })

  await t.test('committed delete rejects waiting prepare and receipt under the same real lock', async () => {
    const f = await fresh(); const i = await prepared(f)
    const holder = await hold(deleteSql(f), { role: 'service_role' })
    try {
      const names = [randomUUID(), randomUUID()]
      const pending = [service(prepare(f), names[0]), service(commit(f, i), names[1])]
      await blocked(names); await holder.send('commit;')
      for (const result of await Promise.all(pending)) { assert.notEqual(result.code, 0); assert.match(errorSummary(result), /tombstone|not active/) }
      assert.equal(JSON.parse(await serviceOk(cleanup(f))).length, 1)
      assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    } finally { await holder.close() }
  })

  await t.test('committed pause rejects waiting intent admission and old receipt without quota changes', async () => {
    const f = await fresh(); const i = await prepared(f)
    const holder = await hold('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user })
    try {
      const names = [randomUUID(), randomUUID()]
      const pending = [service(prepare(f), names[0]), service(commit(f, i), names[1])]
      await blocked(names); await holder.send('commit;')
      for (const result of await Promise.all(pending)) { assert.notEqual(result.code, 0); assert.match(errorSummary(result), /consent required/) }
      assert.equal(await ok(`select count(*) from public.user_file_chunks where manifest_id='${f.manifest}';`), '0')
      assert.deepEqual(await quota(f), { used: 0, reserved: 4 })
    } finally { await holder.close() }
  })

  await t.test('all registered identities including unconfirmed chunks must be fenced before used quota settles', async () => {
    const f = await fixture({ manifest: false })
    f.manifest = await serviceOk(beginSql(f).replace(', 4, 8388608, 1,', ', 8388612, 8388608, 2,'))
    const a = await prepared(f, 0, 8388608); const b = await prepared(f, 1, 4)
    await serviceOk(commit(f, a)); await serviceOk(commit(f, b))
    const s = await snapshot(f)
    await serviceOk(`select public.complete_verified_user_file_upload('${f.user}','${f.manifest}',${s.generation},8388612,'${'a'.repeat(64)}');`)
    await serviceOk(deleteSql(f)); await serviceOk(ack(f, a))
    await denied(finishSql(f), { role: 'service_role' }, /cleanup is incomplete/)
    assert.deepEqual(await quota(f), { used: 8388612, reserved: 0 })
    assert.equal(JSON.parse(await serviceOk(cleanup(f))).length, 2)
    await serviceOk(ack(f, b)); await serviceOk(finishSql(f)); await serviceOk(finishSql(f))
    assert.deepEqual(await quota(f), { used: 0, reserved: 0 })
  })

  await t.test('expired renewal never recycles fenced intent identities', async () => {
    const f = await fresh(); const first = await prepared(f)
    await ok(`update public.user_file_manifests set upload_expires_at=now()-interval '1 hour' where id='${f.manifest}';`)
    await serviceOk(`select manifest_id from public.reap_expired_user_file_uploads('${f.user}');`)
    await denied(finishSql(f), { role: 'service_role' }, /cleanup is incomplete/)
    await serviceOk(ack(f, first)); await serviceOk(finishSql(f))
    assert.equal(await serviceOk(beginSql(f)), f.manifest)
    const second = await prepared(f); assert.notEqual(second.id, first.id); assert.notEqual(second.key, first.key)
    assert.equal(await ok(`select count(*) from public.private_file_write_intents where manifest_id='${f.manifest}';`), '2')
    await denied(commit(f, first), { role: 'service_role' }, /not active/)
    await serviceOk(commit(f, second)); assert.equal((await snapshot(f)).chunks[0].key, second.key)
  })

  await t.test('0022 cleanup projection is owner-only, minimal and available while paused', async () => {
    const f = await fresh(); const i = await prepared(f); await serviceOk(deleteSql(f))
    const other = await fresh(); await serviceOk(deleteSql(other))
    const sql = 'select public.list_private_file_cleanup_jobs();'
    await ok('select public.set_private_file_library_enabled(false);', { role: 'authenticated', user: f.user })
    const jobs = JSON.parse(await ok(sql, { role: 'authenticated', user: f.user }))
    assert.deepEqual(jobs, [{ manifestId: f.manifest, editionId: f.edition, fileName: 'fixture.pdf' }])
    assert.doesNotMatch(JSON.stringify(jobs), /object_key|private-intents|chunk_hash|plaintext_hash/)
    await denied(sql, { role: 'anon' }, /permission denied/)
    await denied(sql, { role: 'service_role' }, /permission denied/)
    await denied(sql, { role: 'authenticated', user: f.user, anonymous: true }, /stable account required/)
    await serviceOk(ack(f, i)); await serviceOk(finishSql(f))
    assert.deepEqual(JSON.parse(await ok(sql, { role: 'authenticated', user: f.user })), [])
    assert.deepEqual(JSON.parse(await ok(sql, { role: 'authenticated', user: other.user })), [{ manifestId: other.manifest, editionId: other.edition, fileName: 'fixture.pdf' }])
  })
})
