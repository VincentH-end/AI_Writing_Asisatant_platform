import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Studio } from '../lib/service.mjs';
import { hash } from '../lib/store.mjs';

function fixture(t, complete=async()=>({output:'新的故事段落。',usage:{total_tokens:123},model:'mock-model',finish_reason:'stop'})){
  const dir=mkdtempSync(join(tmpdir(),'xujian-test-')),app=new Studio(dir,{complete});
  t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true})});
  const call=(method,path,body={},params='')=>app.route(method,path,body,new URLSearchParams(params));
  return {app,dir,call,chapter:app.store.snapshot().chapters[0],pid:app.store.active()};
}
test('generations require acceptance; acceptance is persisted and idempotent',async t=>{
  const {app,call,chapter,pid}=fixture(t);
  const {run}=await call('POST','/api/ai',{task:'continue',chapter_id:chapter.id});
  assert.equal(app.store.get(pid,'chapters',chapter.id).content,chapter.content);
  assert.equal(run.status,'succeeded');assert.ok(run.context_manifest.estimated_total_tokens<=16000);
  await call('POST',`/api/runs/${run.id}/accept`,{destination:'append'});
  await call('POST',`/api/runs/${run.id}/accept`,{destination:'append'});
  const saved=app.store.get(pid,'chapters',chapter.id);
  assert.equal(saved.content,chapter.content+'\n\n新的故事段落。');
  assert.equal(app.store.revisions(pid,chapter.id).length,1);
});
test('reject and draft preserve prose; draft can be accepted later',async t=>{
  const {app,call,chapter,pid}=fixture(t);
  const a=await call('POST','/api/ai',{task:'continue',chapter_id:chapter.id});
  await call('POST',`/api/runs/${a.run.id}/reject`);
  await assert.rejects(call('POST',`/api/runs/${a.run.id}/accept`),e=>e.status===409);
  const b=await call('POST','/api/ai',{task:'continue',chapter_id:chapter.id});
  await call('POST',`/api/runs/${b.run.id}/accept`,{destination:'draft'});
  assert.equal(app.store.get(pid,'chapters',chapter.id).content,chapter.content);
  await call('POST',`/api/runs/${b.run.id}/accept`,{destination:'append'});
  assert.ok(app.store.get(pid,'chapters',chapter.id).content.endsWith('新的故事段落。'));
});
test('stale generation cannot overwrite subsequent edits; revisions restore',async t=>{
  const {app,call,chapter,pid}=fixture(t);
  const {run}=await call('POST','/api/ai',{task:'polish',chapter_id:chapter.id});
  await call('PUT',`/api/chapters/${chapter.id}`,{content:'人工新版本'});
  await assert.rejects(call('POST',`/api/runs/${run.id}/accept`,{destination:'replace'}),e=>e.status===409);
  const {revisions}=await call('GET',`/api/chapters/${chapter.id}/revisions`);
  await call('POST',`/api/chapters/${chapter.id}/restore`,{revision_id:revisions[0].id});
  assert.equal(app.store.get(pid,'chapters',chapter.id).content,chapter.content);
});
test('keys encrypted on disk, omitted from snapshots/export and cleared on endpoint change',async t=>{
  const {app,call,dir}=fixture(t);
  await call('POST','/api/settings',{base_url:'https://example.com/v1',model:'model',api_key:'secret-test-DO-NOT-EXPOSE'});
  assert.equal(app.store.settings(true).api_key,'secret-test-DO-NOT-EXPOSE');
  assert.ok(!JSON.stringify(await call('GET','/api/project')).includes('secret-test-DO-NOT-EXPOSE'));
  assert.ok(!JSON.stringify(await call('GET','/api/export')).includes('secret-test-DO-NOT-EXPOSE'));
  assert.ok(!readFileSync(join(dir,'stories.sqlite-wal')).includes(Buffer.from('secret-test-DO-NOT-EXPOSE')));
  await call('POST','/api/settings',{base_url:'https://different.example/v1'});
  assert.equal(app.store.settings().has_api_key,false);
});
test('project records are isolated and malformed imports roll back',async t=>{
  const {app,call,chapter,pid}=fixture(t);
  const backup=await call('GET','/api/export');
  await call('POST','/api/projects',{title:'第二本书'});
  await assert.rejects(call('PUT',`/api/chapters/${chapter.id}`,{content:'污染'}),e=>e.status===404);
  assert.equal(app.store.get(pid,'chapters',chapter.id).content,chapter.content);
  const count=app.store.projects().length;
  const broken=structuredClone(backup);broken.entities[0].chapter_id='not-a-chapter';
  await assert.rejects(call('POST','/api/import',broken));assert.equal(app.store.projects().length,count);
  const imported=await call('POST','/api/import',backup);
  assert.notEqual(imported.project.id,pid);
  assert.notEqual(imported.chapters[0].id,chapter.id);
  assert.equal(imported.chapters[0].content,chapter.content);
  assert.equal(imported.entities[0].chapter_id,imported.chapters[0].id);
});
test('valid branches enter selection, malformed branches never alter the story',async t=>{
  let good=true;
  const {app,call,chapter,pid}=fixture(t,async()=>({output:good?'```json\n{"branches":[{"title":"A","content":"走向灯塔。"},{"title":"B","content":"回到钟表铺。"}]}\n```':'not-json',finish_reason:'stop'}));
  const result=await call('POST','/api/ai',{task:'branches',chapter_id:chapter.id});
  assert.equal(result.branches.length,2);
  await call('POST',`/api/branches/${result.branches[0].id}/accept`,{destination:'append'});
  assert.ok(app.store.get(pid,'chapters',chapter.id).content.endsWith('走向灯塔。'));
  await assert.rejects(call('POST',`/api/branches/${result.branches[1].id}/accept`),e=>e.status===409);
  good=false;await assert.rejects(call('POST','/api/ai',{task:'branches',chapter_id:chapter.id}),e=>e.status===422);
  assert.equal(app.store.list(pid,'branches').length,2);
  assert.equal(app.store.list(pid,'runs').filter(r=>r.status==='failed').length,1);
});
test('state extraction is validated and keeps historical snapshots on acceptance',async t=>{
  let output;
  const {app,call,chapter,pid}=fixture(t,async()=>({output,finish_reason:'stop'}));
  const entity=app.store.list(pid,'entities').find(e=>e.type==='character');
  output=JSON.stringify({entities:[{id:entity.id,type:entity.type,name:entity.name,description:entity.description,state:'抵达灯塔',relations:[]}],events:[]});
  const {run}=await call('POST','/api/ai',{task:'extract',chapter_id:chapter.id});
  assert.equal(app.store.get(pid,'entities',entity.id).state,entity.state);
  await call('POST',`/api/runs/${run.id}/accept`);
  const updated=app.store.get(pid,'entities',entity.id);
  assert.equal(updated.state,'抵达灯塔');assert.equal(updated.history.at(-1).state,entity.state);
  output=JSON.stringify({entities:[{id:'hallucinated-id',name:'不存在',type:'character'}],events:[]});
  await assert.rejects(call('POST','/api/ai',{task:'extract',chapter_id:chapter.id}),e=>e.status===422);
});
test('auto memory failure reports warning while accepted text stays saved',async t=>{
  const seen=[];
  const {app,call,chapter,pid}=fixture(t,async(s,m,task)=>{seen.push(task);if(task==='extract')throw Object.assign(Error('模拟 API 故障'),{status:502});return {output:task==='summarize'?'本章摘要':'新增段落',finish_reason:'stop'}});
  await call('POST','/api/settings',{auto_update:true});
  const {run}=await call('POST','/api/ai',{task:'continue',chapter_id:chapter.id});
  const result=await call('POST',`/api/runs/${run.id}/accept`);
  assert.equal(result.warnings.length,1);assert.deepEqual(seen,['continue','summarize','extract']);
  const c=app.store.get(pid,'chapters',chapter.id);assert.ok(c.content.endsWith('新增段落'));assert.equal(c.summary_hash,hash(c.content));
});
test('concurrent generation and edits are rejected until the request completes',async t=>{
  let resolve;const waiting=new Promise(r=>resolve=r);
  const {app,call,chapter}=fixture(t,()=>waiting);
  const first=call('POST','/api/ai',{task:'continue',chapter_id:chapter.id});
  await assert.rejects(call('POST','/api/ai',{task:'continue',chapter_id:chapter.id}),e=>e.status===409);
  await assert.rejects(call('PUT',`/api/chapters/${chapter.id}`,{content:'too soon'}),e=>e.status===409);
  resolve({output:'done',finish_reason:'stop'});await first;
  assert.equal(app.locks.size,0);
});
test('database survives restart with settings and records',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'xujian-persist-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let app=new Studio(dir),pid=app.store.active(),c=app.store.snapshot().chapters[0];
  app.saveRecord(pid,'chapters',{content:'持久化文本'},c.id);app.store.saveSettings({model:'my-model',api_key:'secret'});app.close();
  app=new Studio(dir);assert.equal(app.store.get(pid,'chapters',c.id).content,'持久化文本');assert.equal(app.store.settings(true).api_key,'secret');app.close();
});
test('extract acceptance rejects newer manual state changes',async t=>{
  const {app,call,chapter,pid}=fixture(t,async()=>({output:'{"entities":[],"events":[]}',finish_reason:'stop'}));
  const {run}=await call('POST','/api/ai',{task:'extract',chapter_id:chapter.id});
  const e=app.store.list(pid,'entities')[0];await call('PUT',`/api/entities/${e.id}`,{state:'人工确认的状态'});
  await assert.rejects(call('POST',`/api/runs/${run.id}/accept`),e=>e.status===409);
});
test('editing earlier state keeps future current state and records historical snapshot',async t=>{
  const {app,call,chapter,pid}=fixture(t);
  const e=app.store.list(pid,'entities')[0];
  const next=await call('POST','/api/chapters',{title:'第二章'}),cid=next.record.id;
  await call('PUT',`/api/entities/${e.id}`,{state:'第二章最新状态',chapter_id:cid});
  await call('PUT',`/api/entities/${e.id}`,{state:'第一章修正状态',chapter_id:chapter.id});
  const saved=app.store.get(pid,'entities',e.id);
  assert.equal(saved.state,'第二章最新状态');assert.equal(saved.chapter_id,cid);
  assert.equal(saved.history.at(-1).state,'第一章修正状态');
});
test('material generation accepts into library without changing prose and roundtrips run history',async t=>{
  const {app,call,chapter,pid}=fixture(t);
  const {run}=await call('POST','/api/ai',{task:'material',chapter_id:chapter.id});
  await call('POST',`/api/runs/${run.id}/accept`);
  assert.equal(app.store.get(pid,'chapters',chapter.id).content,chapter.content);
  assert.ok(app.store.list(pid,'materials').some(m=>m.content==='新的故事段落。'));
  const backup=await call('GET','/api/export');const restored=await call('POST','/api/import',backup);
  assert.equal(restored.runs.length,backup.runs.length);assert.equal(restored.runs[0].status,'accepted');
});
