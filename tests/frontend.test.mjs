import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('frontend renders views, compiles inline handlers and escapes story HTML',async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements=new Map();
  function el(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){},toggle(){}},querySelectorAll(){return[]},focus(){}});return elements.get(id)}
  const fixture={project:{id:'p1',title:'雾海来信',genre:'奇幻',synopsis:'梗概',outline:'全书大纲'},chapters:[{id:'c1',title:'第一章',position:1,content:'</textarea><img src=x onerror=alert(1)>',outline:'遇见灯塔',status:'draft'}],entities:[{id:'e1',type:'character',name:'林见秋',description:'主角',state:'迷茫',chapter_id:'c1',relations:[{target_id:'e2',label:'旧友',chapter_id:'c1'}],history:[]},{id:'e2',type:'character',name:'沈舟',description:'守灯人',state:'等待',chapter_id:'c1',relations:[],history:[]}],events:[],materials:[],techniques:[],runs:[{id:'r1',task:'continue',chapter_id:'c1',status:'draft',output:'候选内容'}],branches:[],settings:{model:'test',context_budget:16000,max_output_tokens:3000,models:{}}};
  const context=vm.createContext({document:{getElementById:el,querySelectorAll(){return[]},querySelector(){return null},addEventListener(){}},window:{addEventListener(){}},fetch:async()=>({ok:true,text:async()=>JSON.stringify(fixture)}),setTimeout(){},clearTimeout(){},console,URL,Blob});
  vm.runInContext(script,context);await new Promise(r=>setImmediate(r));
  const outputs=[html.replace(/<script>[\s\S]*<\/script>/,'')];
  for(const name of ['editor','outline','characters','world','events','materials','techniques','branches','drafts','review','stats','search','runs'])outputs.push(vm.runInContext(`view='${name}';renderView()`,context));
  for(const code of ["activeRun='r1';resultPanel()","settings();document.getElementById('modalRoot').innerHTML","editRecord('entities','e1');document.getElementById('modalRoot').innerHTML","editRecord('events');document.getElementById('modalRoot').innerHTML","editRecord('materials');document.getElementById('modalRoot').innerHTML","editRecord('techniques');document.getElementById('modalRoot').innerHTML","newChapter();document.getElementById('modalRoot').innerHTML","autonomous();document.getElementById('modalRoot').innerHTML","exportModal();document.getElementById('modalRoot').innerHTML"])outputs.push(vm.runInContext(code,context));
  let count=0;for(const output of outputs)for(const m of output.matchAll(/\bon(?:click|input|change|submit)="([^"]*)"/g)){new Function('event',m[1].replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));count++}
  assert.ok(count>=80);assert.ok(outputs.some(x=>x.includes('relationGraph')));
  assert.ok(outputs[1].includes('&lt;/textarea&gt;&lt;img'));
  assert.ok(!outputs[1].includes('<img src=x'));
  const panel=vm.runInContext("activeRun='r1';resultPanel()",context);assert.ok(panel.includes('接受并追加正文'));
  vm.runInContext('setBusy(true)',context);assert.equal(el('content').inert,true);
});
