import { AppError, endpoint } from './provider.mjs';
export function object(x) { if(!x || typeof x!=='object'||Array.isArray(x))throw new AppError(400,'请求必须是 JSON 对象');return x; }
export function string(x, name, max=10000, required=false) {
  if(typeof x!=='string'||x.length>max||(required&&!x.trim()))throw new AppError(400,`${name} 必须是${required?'非空':''}字符串，且不超过 ${max} 字符`);return x;
}
export function strings(x,name,max=100){if(!Array.isArray(x)||x.length>max||x.some(s=>typeof s!=='string'||s.length>200))throw new AppError(400,`${name} 格式不正确`);return x}
const fields={
  chapters:{title:200,volume:200,content:500000,outline:50000,status:40},
  entities:{type:40,name:200,description:30000,state:10000,chapter_id:100},
  events:{title:200,description:30000,status:50,theme:3000,ending:5000,chapter_id:100},
  materials:{title:200,content:100000},
  techniques:{name:200,scope:50,description:20000,planted_chapter:100,payoff_chapter:100,status:50},
  project:{title:200,genre:200,synopsis:50000,outline:100000,mode:100},
};
export function record(kind, data, partial=false) {
  object(data);const defs=fields[kind];if(!defs)throw new AppError(400,'未知记录类型');const result={};
  for(const [k,max] of Object.entries(defs))if(data[k]!==undefined)result[k]=string(data[k],k,max);
  const key=['entities','techniques'].includes(kind)?'name':'title';
  if(!partial || data[key]!==undefined)string(data[key],key,200,true);
  if(kind==='materials'&&data.tags!==undefined)result.tags=strings(data.tags,'tags',30);
  if(kind==='entities'&&data.relations!==undefined){
    if(!Array.isArray(data.relations)||data.relations.length>100)throw new AppError(400,'关系最多 100 项');
    result.relations=data.relations.map(r=>{object(r);return {target_id:string(r.target_id,'target_id',100,true),label:string(r.label,'label',1000,true),status:string(r.status||'active','status',50),chapter_id:string(r.chapter_id||data.chapter_id||'','chapter_id',100)}});
  }
  return result;
}
export function settingsPatch(data){
  object(data);const p={};
  for(const k of ['base_url','model','api_key','creativity'])if(data[k]!==undefined)p[k]=string(data[k],k,k==='api_key'?2000:1000);
  if(p.base_url!==undefined)endpoint(p.base_url);
  if(p.creativity!==undefined&&!['balanced','divergent','convergent'].includes(p.creativity))throw new AppError(400,'未知创意风格');
  for(const k of ['auto_update','send_temperature'])if(data[k]!==undefined){if(typeof data[k]!=='boolean')throw new AppError(400,k+' 必须为布尔值');p[k]=data[k]}
  if(data.models!==undefined){object(data.models);p.models={};for(const k of ['outline','write','polish','review','material'])if(data.models[k]!==undefined)p.models[k]=string(data.models[k],k,200)}
  for(const [k,min,max] of [['context_budget',4000,200000],['max_output_tokens',128,32000]])if(data[k]!==undefined){if(!Number.isInteger(data[k])||data[k]<min||data[k]>max)throw new AppError(400,`${k} 必须介于 ${min} 和 ${max}`);p[k]=data[k]}
  return p;
}
