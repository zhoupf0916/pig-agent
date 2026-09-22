import { describe, it, expect } from 'vitest';
import { createApp } from '../app.ts';
import { pluginSchema, pluginExperts, pluginSkills } from './plugins.ts';
import { getExpert, updateExpert } from './experts.ts';
const manifest={format:'pig-plugin-v1',id:'test-writing',name:'Writing',version:'1.0.0',description:'Test',skills:[{id:'edit-copy',name:'Edit',description:'Edit copy',body:'Preserve facts.'}],experts:[{id:'editor',name:'Editor',description:'Editing',instruction:'Edit clearly.',skillIds:['edit-copy']}]};
describe('declarative plugins',()=>{
 it('rejects executable fields, duplicate identifiers and dangling references',()=>{
   expect(pluginSchema.safeParse({...manifest,command:'curl evil'}).success).toBe(false);
   expect(pluginSchema.safeParse({...manifest,id:'../../bad'}).success).toBe(false);
   expect(pluginSchema.safeParse({...manifest,skills:[...manifest.skills,...manifest.skills]}).success).toBe(false);
   expect(pluginSchema.safeParse({...manifest,skills:[]}).success).toBe(false);
 });
 it('requires activation, exposes namespaced resources, and revokes future loads without losing historical data',async()=>{
   const app=createApp();
   const send=(path:string,method:string,body?:unknown)=>app.request(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   expect((await send('/api/plugins','POST',manifest)).status).toBe(201);
   expect(await pluginSkills()).toEqual([]);
   expect((await send('/api/plugins','POST',manifest)).status).toBe(400);
   await send('/api/plugins/test-writing','PATCH',{enabled:true});
   expect((await pluginSkills())[0]?.name).toBe('plugin_test-writing_edit-copy');
   expect((await pluginExperts())[0]?.skillIds).toEqual(['plugin_test-writing_edit-copy']);
   expect((await getExpert('plugin_test-writing_editor'))?.instruction).toBe('Edit clearly.');
   await expect(updateExpert('plugin_test-writing_editor',{instruction:'override'})).rejects.toThrow('插件');
   await send('/api/plugins/test-writing','PATCH',{enabled:false});
   expect(await getExpert('plugin_test-writing_editor')).toBeNull();
   expect(await pluginSkills()).toEqual([]);
   await send('/api/plugins/test-writing','DELETE');
   expect((await (await app.request('/api/plugins')).json() as {plugins:unknown[]}).plugins).toEqual([]);
 });
});
