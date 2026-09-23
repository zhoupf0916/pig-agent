import {beforeEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
const mocks=vi.hoisted(()=>({query:vi.fn(),connect:vi.fn()}));
vi.mock('./db.ts',()=>({db:mocks,hash:(x:string)=>x}));
import {registerPlatformRoutes} from './platform.ts';
import type {CloudEnv} from './types.ts';
function app(role='admin') {const a=new Hono<CloudEnv>();a.use('*',async(c,next)=>{c.set('principal',{id:'owner',name:'Owner',role});await next();});registerPlatformRoutes(a);return a;}
function patch(a:Hono<CloudEnv>,body:unknown){return a.request('/v1/admin/accounts/member',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
beforeEach(()=>{mocks.query.mockReset();mocks.connect.mockReset();});
it('普通账号不能修改自己的人民币预算',async()=>{expect((await patch(app('member'),{budgetYuan:100})).status).toBe(403);expect(mocks.connect).not.toHaveBeenCalled();});
it('拒绝负数或不足一分精度的预算而不更新账号',async()=>{for(const budgetYuan of [-1,0.001])expect((await patch(app(),{budgetYuan})).status).toBe(400);expect(mocks.connect).not.toHaveBeenCalled();});
it('管理员设置的人民币额度被保存为整数微元',async()=>{let saved=2000000;const query=vi.fn(async(sql:string,args?:unknown[])=>{if(sql.startsWith('UPDATE principals')){saved=Number(args?.[3]);return {rowCount:1,rows:[{id:'member'}]};}return {rows:[]};});mocks.connect.mockResolvedValue({query,release:vi.fn()});expect((await patch(app(),{budgetYuan:3.25})).status).toBe(200);expect(saved).toBe(3250000);});
