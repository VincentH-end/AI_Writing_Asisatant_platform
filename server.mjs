import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Studio } from './lib/service.mjs';
import { AppError } from './lib/provider.mjs';

const root=dirname(fileURLToPath(import.meta.url));
export function createApp(options={}){
  const studio=new Studio(options.dataDir||process.env.STORY_DATA_DIR||join(root,'data'),options);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    // Local single-user application: no LAN binding and no cross-origin browser access.
    const host=req.headers.host||'';
    const origin=req.headers.origin;
    const validHost=/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
    if(!validHost || (origin&&origin!==`http://${host}`) || req.headers['sec-fetch-site']==='cross-site'){
      res.writeHead(403,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify({error:'仅允许本机同源访问'}));return;
    }
    try{
      const url=new URL(req.url,`http://${host}`);
      if(url.pathname.startsWith('/api/')){
        let body={};
        if(['POST','PUT','PATCH'].includes(req.method)){
          if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new AppError(415,'请使用 application/json');
          const chunks=[];let n=0;const limit=url.pathname==='/api/import'?24*1024*1024:2*1024*1024;
          for await(const chunk of req){n+=chunk.length;if(n>limit)throw new AppError(413,'请求内容过大');chunks.push(chunk)}
          try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw new AppError(400,'JSON 格式错误')}
          if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError(400,'请求必须是对象');
        }
        const result=await studio.route(req.method,url.pathname,body,url.searchParams);
        res.writeHead(200,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(result));
      }else if(req.method==='GET'&&['/','/index.html'].includes(url.pathname)){
        const html=await readFile(join(root,'public','index.html'));
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);
      }else if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end()}
      else throw new AppError(404,'页面不存在');
    }catch(e){
      if(!res.headersSent)res.writeHead(e.status||500,{'Content-Type':'application/json;charset=utf-8'});
      res.end(JSON.stringify({error:e.status?e.message:'服务器内部错误；请检查数据文件权限或重启服务。',...(e.run?{run:e.run}:{})}));
    }
  });
  server.requestTimeout=300000;
  return {server,studio};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server,studio}=createApp();
  const port=Number(process.env.PORT||3210);
  server.listen(port,'127.0.0.1',()=>console.log(`叙间已启动：http://127.0.0.1:${port}\n数据保存在 ${studio.store.dir}\n按 Ctrl+C 停止。`));
  server.on('error',e=>{console.error(`启动失败：${e.code||e.message}`);studio.close();process.exitCode=1});
  const stop=()=>server.close(()=>{studio.close();process.exit(0)});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
