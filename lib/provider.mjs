export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function endpoint(base) {
  let url;
  try { url = new URL(base); } catch { throw new AppError(400, 'API 地址不是有效 URL'); }
  if (url.username || url.password || url.search || url.hash) throw new AppError(400, 'API 地址不能包含账号、密码、查询参数或锚点');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new AppError(400, '远程模型必须使用 HTTPS；本机模型可使用 localhost HTTP');
  if (!url.pathname.replace(/\/$/, '').endsWith('/chat/completions')) url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  return url.href;
}
export function modelFor(settings, task) {
  const group = ({ continue:'write', branches:'write', brainstorm:'write', chat:'write', summarize:'outline', extract:'review' })[task] || task;
  return settings.models?.[group] || settings.model;
}
export async function complete(settings, messages, task, { fetchImpl = fetch, timeout = 120000 } = {}) {
  const url = endpoint(settings.base_url);
  const model = modelFor(settings, task);
  if (!model) throw new AppError(400, '请先在 AI 设置中填写模型 ID（以服务商控制台为准）');
  const local = ['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
  if (!settings.api_key && !local) throw new AppError(400, '请先在 AI 设置中填写 API Key');
  const maxTokens = task === 'test' ? 32 : settings.max_output_tokens;
  const body = { model, messages, stream: false, max_tokens: maxTokens };
  if (settings.send_temperature !== false) body.temperature = ['review','extract','summarize','test'].includes(task) ? 0.2 : ({ divergent:1, convergent:0.35, balanced:0.7 })[settings.creativity] || 0.7;
  let res;
  try {
    res = await fetchImpl(url, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(timeout),
      headers:{'Content-Type':'application/json', ...(settings.api_key ? {Authorization:'Bearer '+settings.api_key} : {})},
      body:JSON.stringify(body),
    });
  } catch (e) {
    throw new AppError(502, e.name === 'TimeoutError' || e.name === 'AbortError' ? '模型请求超过 120 秒，未自动重试以避免重复计费。' : '无法连接模型服务，请检查地址、网络与代理设置。');
  }
  if (!res.ok) {
    // Do not echo upstream bodies: some gateways repeat submitted API keys/prompts.
    const tips = {401:'API Key 无效',403:'服务商拒绝访问',404:'接口地址或模型不存在',429:'配额不足或请求过快',400:'参数或模型不兼容（可关闭 temperature 参数后重试）'};
    throw new AppError(502, `模型服务 HTTP ${res.status}：${tips[res.status] || '服务暂时异常'}。未自动重试。`);
  }
  let raw;
  try {
    const reader = res.body.getReader(); let length=0; const chunks=[];
    while (true) { const {done,value}=await reader.read(); if(done)break;length+=value.length;if(length>4*1024*1024){await reader.cancel();throw Error('large')}chunks.push(value); }
    raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new AppError(502,'模型响应不是有效 JSON、响应过大或读取中断'); }
  const output = raw.choices?.[0]?.message?.content;
  if (typeof output !== 'string' || !output.trim()) throw new AppError(502,'模型未返回可用正文（需要兼容 Chat Completions 的文本 content）');
  return { output:output.trim(), usage:raw.usage || {}, model:raw.model || model, finish_reason:raw.choices[0].finish_reason || 'unknown' };
}
export function jsonOutput(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { const data=JSON.parse(clean); if(!data || typeof data!=='object'||Array.isArray(data))throw Error(); return data; }
  catch { throw new AppError(422,'模型没有返回要求的结构化 JSON。原始输出已保留，可查看后重新生成。'); }
}
