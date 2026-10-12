import { Store, id, now, hash, collections } from './store.mjs';
import { AppError, complete, jsonOutput } from './provider.mjs';
import { object, string, strings, record, settingsPatch } from './validate.mjs';
import { buildContext } from './context.mjs';

export const tasks = ['continue','outline','polish','review','branches','brainstorm','chat','summarize','extract','material'];
export class Studio {
  constructor(dir, options={}) { this.store=new Store(dir);this.complete=options.complete || complete;this.locks=new Set(); }
  close(){this.store.close()}
  worldHash(pid){return hash(JSON.stringify(['entities','events'].flatMap(k=>this.store.list(pid,k)).sort((a,b)=>a.id.localeCompare(b.id))))}
  versionState(pid,old,next){
    const snapshot=r=>{const {history,project_id,updated_at,...data}=r;return {...data,created_at:now()}};
    if(!old)return {...next,history:[]};
    const positions=new Map(this.store.list(pid,'chapters').map(c=>[c.id,c.position]));
    const oldPos=positions.get(old.chapter_id)??-1,newPos=positions.get(next.chapter_id)??-1;
    if(oldPos>newPos)return {...old,history:[...(old.history||[]),snapshot(next)]};
    return {...next,history:[...(old.history||[]),snapshot(old)]};
  }
  get(pid,kind,rid){const x=this.store.get(pid,kind,rid);if(!x)throw new AppError(404,'未找到当前项目中的记录');return x}
  async locked(pid,fn){if(this.locks.has(pid))throw new AppError(409,'此项目正在运行 AI 或保存状态，请等待当前任务完成');this.locks.add(pid);try{return await fn()}finally{this.locks.delete(pid)}}
  checkRefs(pid,kind,data){
    for(const key of ['chapter_id','planted_chapter','payoff_chapter'])if(data[key])this.get(pid,'chapters',data[key]);
    for(const r of data.relations||[]){this.get(pid,'entities',r.target_id);if(r.chapter_id)this.get(pid,'chapters',r.chapter_id)}
  }
  saveRecord(pid,kind,body,rid){
    if(this.locks.has(pid))throw new AppError(409,'项目正在生成，请稍后编辑');
    const data=record(kind,body,!!rid),old=rid?this.get(pid,kind,rid):null;
    this.checkRefs(pid,kind,data);
    return this.store.transaction(()=>{
      let saved={...(old||{}),...data};
      if(!old){saved.id=id();saved.created_at=now()}
      if(kind==='chapters'){
        if(old)this.store.revision(pid,old);
        else saved={content:'',outline:'',summary:'',volume:'第一卷',status:'draft',position:Math.max(0,...this.store.list(pid,kind).map(c=>c.position))+1,...saved};
        if(old && data.content!==undefined && data.content!==old.content){saved.summary='';saved.summary_hash=''}
      }
      if(['entities','events'].includes(kind)){
        if(kind==='entities')saved.relations=saved.relations||[];
        saved=this.versionState(pid,old,saved);
      }
      return this.store.put(pid,kind,saved);
    });
  }
  async generate(pid,body){
    object(body);if(!tasks.includes(body.task))throw new AppError(400,'不支持的 AI 任务');
    const chapter=this.get(pid,'chapters',string(body.chapter_id,'chapter_id',100,true));
    const prompt=string(body.prompt||'','prompt',30000);
    for(const k of ['selected_entity_ids','selected_material_ids','selected_technique_ids'])if(body[k]!==undefined)strings(body[k],k,30);
    for(const [key,kind] of [['selected_entity_ids','entities'],['selected_material_ids','materials'],['selected_technique_ids','techniques']])for(const rid of body[key]||[])this.get(pid,kind,rid);
    return this.locked(pid,()=>this.run(pid,{...body,prompt},chapter));
  }
  async run(pid,body,chapter){
    const snapshot=this.store.snapshot(pid),settings=this.store.settings(true);
    const ctx=buildContext({...snapshot,...body,chapter,settings});
    let run=this.store.put(pid,'runs',{
      id:id(),created_at:now(),task:body.task,chapter_id:chapter.id,prompt:body.prompt||'',status:'running',output:'',error:'',
      base_hash:hash(chapter.content),base_outline_hash:hash(chapter.outline),base_world_hash:this.worldHash(pid),context_manifest:ctx.manifest,
    });
    try{
      const result=await this.complete(settings,ctx.messages,body.task);
      run={...run,...result,status:'succeeded'};
      if(result.finish_reason==='length')run.warning='达到输出上限，内容可能未完成，请检查后接受。';
      let branches=[];
      if(body.task==='branches'){
        const data=jsonOutput(result.output);
        if(!Array.isArray(data.branches)||data.branches.length<1||data.branches.length>5)throw new AppError(422,'分支输出应包含 1–5 个 branches');
        branches=data.branches.map(b=>({id:id(),run_id:run.id,chapter_id:chapter.id,title:string(b.title,'分支标题',200,true),content:string(b.content,'分支正文',50000,true),status:'pending',base_hash:hash(chapter.content),created_at:now()}));
      }
      if(body.task==='extract')this.validateExtraction(pid,result.output);
      this.store.transaction(()=>{run=this.store.put(pid,'runs',run);for(const b of branches)this.store.put(pid,'branches',b)});
      return {run,branches};
    }catch(e){
      run=this.store.put(pid,'runs',{...run,status:'failed',error:e.status?e.message:'任务处理失败，未修改正文。'});
      // Keep generated text in run even when its schema is invalid.
      e.run=run;throw e;
    }
  }
  validateExtraction(pid,output){
    const data=jsonOutput(output);
    if(!Array.isArray(data.entities)||!Array.isArray(data.events)||data.entities.length>30||data.events.length>30)throw new AppError(422,'状态输出需要 entities 与 events 数组，每类最多 30 项');
    const normalized={entities:[],events:[]};
    for(const kind of ['entities','events'])for(const item of data[kind]){
      let clean;
      try{clean=record(kind,item)}catch(e){throw new AppError(422,'状态提取字段不完整：'+e.message)}
      // Models may invent IDs. Only explicit existing IDs or exact names can update a record.
      const nameKey=kind==='entities'?'name':'title';
      let old=item.id?this.store.get(pid,kind,item.id):null;
      if(item.id&&!old)throw new AppError(422,'状态提取引用了未知 ID，请重新生成');
      if(!old)old=this.store.list(pid,kind).find(r=>r[nameKey]===clean[nameKey]);
      if(old && kind==='entities' && old.type!==clean.type)throw new AppError(422,'人物或道具类型与已有唯一索引冲突');
      for(const relation of clean.relations||[])if(!this.store.get(pid,'entities',relation.target_id))throw new AppError(422,'关系引用了未知人物 ID');
      normalized[kind].push({...clean,...(old?{id:old.id}:{})});
    }
    return normalized;
  }
  applyExtraction(pid,chapter,output){
    const data=this.validateExtraction(pid,output);
    for(const kind of ['entities','events'])for(const item of data[kind]){
      const old=item.id?this.get(pid,kind,item.id):null;
      const next={...old,...item,id:old?.id||id(),chapter_id:chapter.id,...(kind==='entities'?{relations:(item.relations||old?.relations||[]).map(r=>({...r,chapter_id:chapter.id}))}:{}),created_at:old?.created_at||now()};
      this.store.put(pid,kind,this.versionState(pid,old,next));
    }
  }
  async accept(pid,rid,body={}){
    return this.locked(pid,async()=>{
      const run=this.get(pid,'runs',rid),chapter=this.get(pid,'chapters',run.chapter_id);
      if(run.status==='accepted')return this.store.snapshot(pid);
      if(!['succeeded','draft'].includes(run.status))throw new AppError(409,'此生成结果不能被接受');
      const destination=body.destination||'append';
      if(!['append','replace','draft'].includes(destination))throw new AppError(400,'未知接受方式');
      if(destination==='draft'){this.store.put(pid,'runs',{...run,status:'draft'});return this.store.snapshot(pid)}
      if(run.task==='branches')throw new AppError(400,'请选择具体分支，不能把分支 JSON 插入正文');
      if(['review','chat'].includes(run.task))throw new AppError(400,'审阅与对话只提供建议，请手动编辑或存入草稿');
      if(run.base_hash!==hash(chapter.content) || (run.task==='outline'&&run.base_outline_hash!==hash(chapter.outline)))throw new AppError(409,'章节在生成后已发生变化。结果仍保留，请保存为草稿或重新生成，避免覆盖新内容。');
      if(run.task==='extract' && run.base_world_hash && run.base_world_hash!==this.worldHash(pid))throw new AppError(409,'人物或事件在提取后已修改，请重新提取，避免覆盖人工设置。');
      this.store.transaction(()=>{
        this.store.revision(pid,chapter);
        if(run.task==='material')this.store.put(pid,'materials',{title:'AI 素材 · '+chapter.title,content:run.output,tags:['AI 创作灵感','非联网检索'],created_at:now()});
        else if(run.task==='extract')this.applyExtraction(pid,chapter,run.output);
        else if(run.task==='summarize')this.store.put(pid,'chapters',{...chapter,summary:run.output,summary_hash:hash(chapter.content)});
        else if(run.task==='outline')this.store.put(pid,'chapters',{...chapter,outline:run.output});
        else this.store.put(pid,'chapters',{...chapter,content:destination==='replace'?run.output:[chapter.content,run.output].filter(Boolean).join('\n\n'),summary:'',summary_hash:'',status:'draft'});
        this.store.put(pid,'runs',{...run,status:'accepted',accepted_at:now()});
      });
      const result=await this.maintain(pid,chapter.id,['continue','polish','brainstorm'].includes(run.task));
      return {...this.store.snapshot(pid),warnings:result};
    });
  }
  async maintain(pid,cid,enabled){
    const warnings=[];
    if(!enabled || !this.store.settings().auto_update)return warnings;
    // Bounded worker roles. Memory workers cannot edit prose or invoke tools.
    for(const task of ['summarize','extract']){
      try{
        const chapter=this.get(pid,'chapters',cid),{run}=await this.run(pid,{task,prompt:'只分析当前已接受章节，按规则维护故事记忆。'},chapter);
        this.store.transaction(()=>{
          if(task==='summarize')this.store.put(pid,'chapters',{...chapter,summary:run.output,summary_hash:hash(chapter.content)});
          else this.applyExtraction(pid,chapter,run.output);
          this.store.put(pid,'runs',{...run,status:'accepted',accepted_at:now(),auto_maintenance:true});
        });
      }catch(e){warnings.push(`正文已保存，但${task==='summarize'?'摘要':'状态'}自动更新失败：${e.status?e.message:'内部错误'}`)}
    }
    return warnings;
  }
  async acceptBranch(pid,bid,body={}){
    return this.locked(pid,async()=>{
      const b=this.get(pid,'branches',bid),c=this.get(pid,'chapters',b.chapter_id);
      if(b.status==='accepted')return this.store.snapshot(pid);
      if(b.status!=='pending')throw new AppError(409,'此分支已处理');
      const destination=body.destination||'append';if(!['append','draft'].includes(destination))throw new AppError(400,'分支只能追加或存草稿');
      if(destination==='append'&&b.base_hash!==hash(c.content))throw new AppError(409,'章节已变更，请将分支存入草稿后重新生成');
      this.store.transaction(()=>{
        if(destination==='draft')this.store.put(pid,'runs',{id:id(),task:'continue',chapter_id:c.id,output:b.content,prompt:'分支：'+b.title,status:'draft',base_hash:b.base_hash,context_manifest:{branch_id:b.id},created_at:now()});
        else{this.store.revision(pid,c);this.store.put(pid,'chapters',{...c,content:[c.content,b.content].filter(Boolean).join('\n\n'),summary:'',summary_hash:''})}
        this.store.put(pid,'branches',{...b,status:destination==='draft'?'draft':'accepted'});
      });
      const warnings=await this.maintain(pid,c.id,destination==='append');
      return {...this.store.snapshot(pid),warnings};
    });
  }
  export(pid){const s=this.store.snapshot(pid);delete s.settings;delete s.stats;return {format:'xujian-story-studio',version:1,exported_at:now(),...s}}
  import(body){
    object(body);if(body.format!=='xujian-story-studio'||body.version!==1)throw new AppError(400,'仅支持本平台 version 1 JSON 项目文件');
    const p=record('project',body.project),map=new Map();
    for(const kind of collections){if(!Array.isArray(body[kind]||[])||(body[kind]||[]).length>5000)throw new AppError(400,'导入记录过多或格式错误');for(const r of body[kind]||[]){object(r);string(r.id,'id',100,true);if(map.has(r.id))throw new AppError(400,'导入文件包含重复 ID');map.set(r.id,id())}}
    const remap=(value)=>{if(Array.isArray(value))return value.map(remap);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,remap(v)]));return typeof value==='string'&&map.has(value)?map.get(value):value};
    return this.store.transaction(()=>{
      const pid=id();this.store.putProject({...p,id:pid,created_at:now()});
      for(const kind of ['chapters','entities','events','materials','techniques'])for(const [idx,raw] of (body[kind]||[]).entries()){
        const mapped=remap(raw),clean=record(kind,mapped);
        let extras={};
        if(kind==='chapters')extras={position:idx+1,summary:typeof raw.summary==='string'?raw.summary.slice(0,50000):'',summary_hash:raw.summary_hash===hash(raw.content)?raw.summary_hash:''};
        if(['entities','events'].includes(kind)){
          if(!Array.isArray(mapped.history||[])||(mapped.history||[]).length>10000)throw new AppError(400,'人物历史格式错误');
          extras.history=(mapped.history||[]).map(h=>({...record(kind,h,true),created_at:string(h.created_at||now(),'created_at',100)}));
        }
        this.store.put(pid,kind,{...clean,...extras,id:mapped.id,created_at:now()});
      }
      if(!this.store.list(pid,'chapters').length)this.store.put(pid,'chapters',{title:'第一章',volume:'第一卷',content:'',outline:'',summary:'',position:1,status:'draft'});
      for(const kind of ['entities','events','techniques'])for(const r of this.store.list(pid,kind))this.checkRefs(pid,kind,r);
      for(const raw of body.runs||[]){
        const mapped=remap(raw),c=this.get(pid,'chapters',mapped.chapter_id);
        if(!tasks.includes(raw.task))throw new AppError(400,'导入生成任务类型错误');
        const status=['accepted','rejected','draft','failed'].includes(raw.status)?raw.status:raw.status==='succeeded'?'draft':'failed';
        const usage={};for(const k of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(raw.usage?.[k])&&raw.usage[k]>=0)usage[k]=raw.usage[k];
        this.store.put(pid,'runs',{id:mapped.id,task:raw.task,chapter_id:c.id,output:string(raw.output||'','output',200000),status,prompt:string(raw.prompt||'','prompt',30000),error:string(raw.error||'','error',3000),model:string(raw.model||'','model',200),usage,base_hash:raw.base_hash||hash(c.content),base_outline_hash:raw.base_outline_hash||hash(c.outline),...(raw.task==='extract'?{base_world_hash:this.worldHash(pid)}:{}),context_manifest:{imported:true,original:object(mapped.context_manifest||{})},created_at:string(raw.created_at||now(),'created_at',100)});
      }
      for(const raw of body.branches||[]){const r=remap(raw),c=this.get(pid,'chapters',r.chapter_id);this.store.put(pid,'branches',{id:r.id,chapter_id:c.id,title:string(r.title,'title',200,true),content:string(r.content,'content',50000,true),base_hash:r.base_hash||hash(c.content),status:['pending','accepted','draft'].includes(r.status)?r.status:'pending',created_at:string(r.created_at||now(),'created_at',100)})}
      this.store.meta('active_project',pid);return this.store.snapshot(pid);
    });
  }
  async route(method,path,body,query){
    const s=this.store,pid=s.active();
    if(path==='/api/health'&&method==='GET')return {ok:true,version:'1.0.0'};
    if(path==='/api/project'&&method==='GET')return s.snapshot(pid);
    if(path==='/api/projects'&&method==='GET')return {projects:s.projects(),active_project:pid};
    if(path==='/api/projects'&&method==='POST'){const data=record('project',body);s.transaction(()=>s.newProject(data));return s.snapshot()}
    if(path==='/api/projects/select'&&method==='POST'){if(!s.project(body.id))throw new AppError(404,'项目不存在');s.meta('active_project',body.id);return s.snapshot()}
    if(path==='/api/project'&&method==='PUT'){if(this.locks.has(pid))throw new AppError(409,'项目正在生成');s.putProject({...s.project(pid),...record('project',body,true)});return s.snapshot(pid)}
    if(path==='/api/settings'&&method==='GET')return s.settings();
    if(path==='/api/settings'&&method==='POST'){
      if(this.locks.size)throw new AppError(409,'生成过程中不能更改模型配置');
      const patch=settingsPatch(body),next={...s.settings(),...patch};if(next.context_budget-next.max_output_tokens<2500)throw new AppError(400,'上下文预算须比输出上限至少多 2500');return s.saveSettings(patch);
    }
    if(path==='/api/settings/test'&&method==='POST'){const r=await this.complete(s.settings(true),[{role:'user',content:'请只回复 OK。'}],'test');return {ok:true,reply:r.output,model:r.model}}
    if(path==='/api/ai'&&method==='POST')return this.generate(pid,body);
    if(path==='/api/export'&&method==='GET')return this.export(pid);
    if(path==='/api/import'&&method==='POST')return this.import(body);
    if(path==='/api/search'&&method==='GET'){
      const q=(query.get('q')||'').trim().toLowerCase().slice(0,200);if(!q)return {results:[]};
      const results=[];for(const kind of ['chapters','entities','events','materials','techniques'])for(const r of s.list(pid,kind)){
        const title=r.title||r.name,text=[r.content,r.description,r.state,r.outline,r.theme,r.ending].filter(Boolean).join('\n');
        const idx=(title+' '+text).toLowerCase().indexOf(q);if(idx>=0)results.push({type:kind,id:r.id,title,text:text.slice(Math.max(0,idx-70),idx+400)});
      }return {results:results.slice(0,100)};
    }
    const parts=path.split('/').filter(Boolean),kind=parts[1],rid=parts[2],action=parts[3];
    if(kind==='chapters'&&rid&&action==='revisions'&&method==='GET'){this.get(pid,kind,rid);return {revisions:s.revisions(pid,rid)}}
    if(kind==='chapters'&&rid&&action==='restore'&&method==='POST'){
      if(this.locks.has(pid))throw new AppError(409,'项目正在生成');const old=this.get(pid,kind,rid),rev=s.revisions(pid,rid).find(r=>r.id===body.revision_id);if(!rev)throw new AppError(404,'历史版本不存在');s.transaction(()=>{s.revision(pid,old);s.put(pid,kind,{...rev.chapter,id:rid,summary:'',summary_hash:''})});return s.snapshot(pid);
    }
    if(kind==='runs'&&rid&&method==='POST'){
      if(action==='accept')return this.accept(pid,rid,body);
      if(action==='reject'){const r=this.get(pid,kind,rid);if(r.status==='accepted'||r.status==='running')throw new AppError(409,'此结果已接受或仍在生成');s.put(pid,kind,{...r,status:'rejected'});return s.snapshot(pid)}
    }
    if(kind==='branches'&&rid&&action==='accept'&&method==='POST')return this.acceptBranch(pid,rid,body);
    if(['chapters','entities','events','materials','techniques'].includes(kind)){
      if(method==='POST'&&!rid){const saved=this.saveRecord(pid,kind,body);return {...s.snapshot(pid),record:saved}}
      if(method==='PUT'&&rid&&!action){const saved=this.saveRecord(pid,kind,body,rid);return {...s.snapshot(pid),record:saved}}
    }
    throw new AppError(404,'API 路径不存在');
  }
}
