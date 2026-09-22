import { Hono } from 'hono';
/** The public Web entry never instantiates the local agent, filesystem APIs or scheduler. */
export function createWebEntry(controlPlaneUrl: string) {
  const app=new Hono();
  let target:URL;
  try {target=new URL(controlPlaneUrl);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('Invalid URL');}
  catch {throw Error('请配置有效的控制面地址 CLOUD_WEB_URL');}
  app.get('/api/deployment',c=>c.json({surface:'cloud',controlPlaneUrl:target.origin}));
  app.get('/api/health',c=>c.json({ok:true,name:'pig-agent-web-entry',surface:'cloud'}));
  app.all('/api/*',c=>c.json({error:'Web 仅支持云端执行；本机工作区和执行能力请使用桌面客户端'},410));
  app.get('*',c=>c.redirect(target.origin+'/',302));
  return app;
}
