import assert from 'node:assert/strict';

// This check deliberately uses only the portable preview's mock identity and DB.
const origin = process.env.LOCAL_TEST_URL || 'http://127.0.0.1:5173';
const url = new URL(origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local checks must never target a hosted site');
const password = 'local-test-vault-only-2026!';
const secondPassword = 'local-test-vault-changed-2026!';
const cookies = new Map();
let checks = 0;
async function request(path, {method = 'GET', body, withCookies = true, requestOrigin = origin} = {}) {
  const headers = { ...(withCookies ? {cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ')} : {}) };
  if (method !== 'GET') headers.Origin = requestOrigin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(origin + path, { method, headers, redirect: 'manual', ...(body !== undefined ? {body:JSON.stringify(body)} : {}) });
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0,i), pair.slice(i+1));
  }
  let json;
  try {json = await response.json();} catch {json = null;}
  return {status:response.status, json, headers:response.headers};
}
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

check((await request('/api/notes', {withCookies:false})).status, 401, 'Anonymous note reads are blocked');
check((await request('/api/backup', {withCookies:false})).status, 401, 'Anonymous backups are blocked');
await request('/signin-with-chatgpt?return_to=/');
const initial = await request('/api/vault');
check(initial.status, 200, 'Local mock identity is recognized');
if (!initial.json.configured) {
  check((await request('/api/vault', {method:'POST',body:{action:'setup',password:'short'}})).status, 400, 'Short setup passwords rejected');
  check((await request('/api/vault', {method:'POST',body:{action:'setup',password}})).status, 200, 'Vault can be configured');
} else {
  const unlocked = await request('/api/vault', {method:'POST',body:{action:'unlock',password}});
  assert.equal(unlocked.status, 200, 'Local DB must be dedicated to these checks; do not use real notes here');
}
check((await request('/api/vault')).json.unlocked, true, 'Session unlocks vault');
const notes = await request('/api/notes');
check(notes.status, 200, 'Unlocked note read');
check(notes.headers.get('cache-control')?.includes('no-store'), true, 'Private data is not cached');
const created = await request('/api/notes', {method:'POST',body:{title:'Integration fixture',content:'# Private fixture\n\nA test note.',notebook:'测试',tags:['test'],favorite:false,archived:false}});
check(created.status, 201, 'Note creation');
let note = created.json.note;
const crossOrigin = await request('/api/notes', {method:'POST',requestOrigin:'https://untrusted.example',body:{title:'Blocked',content:'',notebook:'',tags:[],favorite:false,archived:false}});
check(crossOrigin.status, 403, 'Cross-origin writes rejected');
const updated = await request('/api/notes/' + note.id, {method:'PUT',body:{...note,title:'Updated fixture',expectedUpdatedAt:note.updatedAt}});
check(updated.status, 200, 'Note update');
check((await request('/api/notes/' + note.id, {method:'PUT',body:{...note,title:'Stale fixture',expectedUpdatedAt:note.updatedAt}})).status, 409, 'Stale writes rejected');
note = updated.json.note;
check((await request('/api/notes/' + note.id, {method:'DELETE'})).status, 409, 'Live notes cannot be permanently deleted');
const exported = await request('/api/backup');
check(exported.status, 200, 'Unlocked export');
const imported = await request('/api/backup', {method:'POST',body:{version:1,exportedAt:Date.now(),notes:[note]}});
check(imported.status, 200, 'Backup merge');
const afterImport = await request('/api/notes');
check(afterImport.json.notes.filter(n=>n.title === 'Updated fixture').length, 2, 'Import adds new IDs without overwriting');
const archived = await request('/api/notes/' + note.id, {method:'PUT',body:{...note,archived:true,expectedUpdatedAt:note.updatedAt}});
check(archived.status, 200, 'Move to trash');
check((await request('/api/notes/' + note.id, {method:'DELETE'})).status, 200, 'Trash deletion');
const oldCookies = new Map(cookies);
check((await request('/api/vault', {method:'POST',body:{action:'change-password',password,newPassword:secondPassword}})).status, 200, 'Password change');
const oldCookieString = [...oldCookies].map(([k,v])=>`${k}=${v}`).join('; ');
const oldSession = await fetch(origin + '/api/notes', {headers:{cookie:oldCookieString},redirect:'manual'});
check(oldSession.status, 423, 'Password change revokes old sessions');
check((await request('/api/vault', {method:'POST',body:{action:'unlock',password:secondPassword}})).status, 200, 'New password unlocks');
check((await request('/api/vault', {method:'POST',body:{action:'change-password',password:secondPassword,newPassword:password}})).status, 200, 'Restore repeatable local test password');
await request('/api/vault', {method:'POST',body:{action:'unlock',password}});
for(const n of (await request('/api/notes')).json.notes.filter(n=>['Integration fixture','Updated fixture'].includes(n.title))) {
  if(!n.archived) await request('/api/notes/'+n.id,{method:'PUT',body:{...n,archived:true,expectedUpdatedAt:n.updatedAt}});
  await request('/api/notes/'+n.id,{method:'DELETE'});
}
check((await request('/api/vault', {method:'POST',body:{action:'lock'}})).status, 200, 'Lock');
check((await request('/api/notes')).status, 423, 'Locked note reads blocked');
check((await request('/api/backup')).status, 423, 'Locked backups blocked');
check((await request('/api/notes', {method:'POST',body:{title:'Blocked',content:'',notebook:'',tags:[],favorite:false,archived:false}})).status, 423, 'Locked writes blocked');
console.log(`Passed ${checks} local HTTP integration checks.`);
