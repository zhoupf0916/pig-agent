import type { Hono } from "hono";
import { changePlugins, installPlugin, listPlugins, pluginSchema } from "../store/plugins.ts";
export function registerPluginRoutes(app:Hono) {
  app.get('/api/plugins',async c=>{try{return c.json({plugins:await listPlugins()});}catch{return c.json({error:'插件配置无法读取'},500);}});
  app.post('/api/plugins/preview',async c=>{
    const raw=await c.req.text();if(raw.length>600000)return c.json({error:'插件文件不能超过 600 KB'},413);
    try {return c.json({manifest:pluginSchema.parse(JSON.parse(raw))});}catch{return c.json({error:'插件格式无效：仅支持 pig-plugin-v1 专家与技能包，不支持脚本或工具命令'},400);}
  });
  app.post('/api/plugins',async c=>{
    const raw=await c.req.text();if(raw.length>600000)return c.json({error:'插件文件过大'},413);
    try{return c.json({plugins:await installPlugin(JSON.parse(raw))},201);}catch(e){return c.json({error:e instanceof Error?e.message:'导入失败'},400);}
  });
  app.patch('/api/plugins/:id',async c=>{
    const body=await c.req.json().catch(()=>({}));if(typeof body.enabled!=='boolean')return c.json({error:'enabled 必须为布尔值'},400);
    try {return c.json({plugins:await changePlugins(items=>{if(!items.some(p=>p.manifest.id===c.req.param('id')))throw Error('插件不存在');return items.map(p=>p.manifest.id===c.req.param('id')?{...p,enabled:body.enabled}:p);})});}catch(e){return c.json({error:String(e)},400);}
  });
  app.delete('/api/plugins/:id',async c=>c.json({plugins:await changePlugins(items=>items.filter(p=>p.manifest.id!==c.req.param('id')))}));
}
