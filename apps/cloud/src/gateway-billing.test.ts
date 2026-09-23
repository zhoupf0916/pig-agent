import {it,expect,vi} from 'vitest';
const captured=vi.hoisted(()=>({fetch:undefined as undefined|((r:Request)=>Promise<Response>)}));
vi.mock('@hono/node-server',()=>({serve:(options:{fetch:(r:Request)=>Promise<Response>})=>{captured.fetch=options.fetch;}}));
import './gateway.ts';
it('提供商明确拒绝请求时释放预留金额，不消耗用户模型额度',async()=>{
 let released=false;
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  const path=String(url);
  if(path.endsWith('/internal/authorize'))return Response.json({billingId:'1',provider:{baseUrl:'https://model.test',apiKey:'test-only',model:'fixture'}});
  if(path.endsWith('/internal/model-settle')){const b=JSON.parse(String(options?.body));released=b.usage.prompt_tokens===0&&b.usage.completion_tokens===0;return Response.json({ok:true});}
  return new Response('invalid request',{status:400});
 });
 try{const response=await captured.fetch!(new Request('http://gateway/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'test'}]})}));expect(response.status).toBe(502);expect(released).toBe(true);}finally{fetch.mockRestore();}
});
