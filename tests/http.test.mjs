import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

// Exercise the actual HTTP request listener without binding a TCP socket.
// Loopback network access is separately verified, never implied by these tests.
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'xujian-http-'));
  const {server,studio}=createApp({dataDir:dir});
  t.after(()=>{studio.close();rmSync(dir,{recursive:true,force:true})});
  const request=(method,url,body,headers={})=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);
    Object.assign(req,{method,url,headers:{host:'127.0.0.1:3210',...headers}});
    const out={status:200,headers:{},text:''};
    const res={headersSent:false,setHeader(k,v){out.headers[k.toLowerCase()]=v},writeHead(status,hs={}){out.status=status;this.headersSent=true;for(const [k,v]of Object.entries(hs))this.setHeader(k,v)},end(text=''){out.text=String(text);resolve(out)}};
    server.emit('request',req,res);
  });
  return {request};
}
test('HTTP handler serves the actual page and JSON health endpoint',async t=>{
  const {request}=fixture(t);
  const page=await request('GET','/');assert.equal(page.status,200);assert.ok(page.text.includes('创作 Agent'));assert.ok(page.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  const health=await request('GET','/api/health');assert.deepEqual(JSON.parse(health.text),{ok:true,version:'1.0.0'});
});
test('HTTP handler rejects remote origins, DNS rebinding host and invalid JSON',async t=>{
  const {request}=fixture(t);
  assert.equal((await request('GET','/api/project',undefined,{origin:'https://evil.example'})).status,403);
  assert.equal((await request('GET','/api/project',undefined,{host:'evil.example'})).status,403);
  assert.equal((await request('POST','/api/projects','{}',{'content-type':'text/plain'})).status,415);
  assert.equal((await request('POST','/api/projects','{bad',{'content-type':'application/json'})).status,400);
});
test('HTTP handler persists valid mutations and shields private files',async t=>{
  const {request}=fixture(t);
  const created=await request('POST','/api/projects','{"title":"HTTP 测试小说"}',{'content-type':'application/json',origin:'http://127.0.0.1:3210'});
  assert.equal(created.status,200);assert.equal(JSON.parse(created.text).project.title,'HTTP 测试小说');
  assert.equal((await request('GET','/data/master.key')).status,404);
  assert.equal((await request('GET','/../lib/store.mjs')).status,404);
});
