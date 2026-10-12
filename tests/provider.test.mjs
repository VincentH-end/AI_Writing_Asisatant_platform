import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, endpoint, modelFor } from '../lib/provider.mjs';
const settings={base_url:'https://example.com/v1',model:'base',models:{write:'writer',review:'critic'},api_key:'secret',max_output_tokens:500};
test('compatible endpoint normalization and transport safety',()=>{
  assert.equal(endpoint('https://example.com/v1/'),'https://example.com/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:11434/v1'),'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(endpoint('https://example.com/chat/completions'),'https://example.com/chat/completions');
  for(const url of ['http://example.com','https://user:pass@example.com','https://example.com?key=abc','file:///tmp'])assert.throws(()=>endpoint(url));
  assert.equal(modelFor(settings,'continue'),'writer');assert.equal(modelFor(settings,'extract'),'critic');
});
test('provider sends actual Chat Completions payload and parses output',async()=>{
  const result=await complete(settings,[{role:'user',content:'写故事'}],'continue',{fetchImpl:async(url,init)=>{
    assert.equal(url,'https://example.com/v1/chat/completions');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer secret');
    const body=JSON.parse(init.body);assert.equal(body.model,'writer');assert.equal(body.stream,false);assert.equal(body.messages[0].content,'写故事');
    return new Response(JSON.stringify({choices:[{message:{content:'正文'},finish_reason:'stop'}],usage:{total_tokens:9}}));
  }});assert.equal(result.output,'正文');assert.equal(result.usage.total_tokens,9);
});
test('provider propagates failures without reflecting secrets',async()=>{
  await assert.rejects(complete(settings,[],'continue',{fetchImpl:async()=>new Response('secret',{status:401})}),e=>e.status===502&&!e.message.includes('secret'));
  await assert.rejects(complete(settings,[],'continue',{fetchImpl:async()=>{throw Object.assign(Error('secret'),{name:'TimeoutError'})}}),e=>e.message.includes('120 秒')&&!e.message.includes('secret'));
  await assert.rejects(complete(settings,[],'continue',{fetchImpl:async()=>new Response('{invalid')}),e=>e.status===502);
  await assert.rejects(complete(settings,[],'continue',{fetchImpl:async()=>new Response('{"choices":[]}')}),e=>e.status===502);
});
test('temperature can be disabled and remote missing key fails before request',async()=>{
  await complete({...settings,send_temperature:false},[],'test',{fetchImpl:async(url,init)=>{const p=JSON.parse(init.body);assert.ok(!('temperature' in p));assert.equal(p.max_tokens,32);return new Response('{"choices":[{"message":{"content":"OK"}}]}')}});
  await assert.rejects(complete({...settings,api_key:''},[],'test'),e=>e.status===400);
});
