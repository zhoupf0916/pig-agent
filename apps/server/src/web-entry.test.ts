import {describe,it,expect} from 'vitest';
import {createWebEntry} from './web-entry.ts';
describe('cloud-only web entry',()=>{
 it('redirects frontend visitors and refuses local execution, settings and files',async()=>{
  const app=createWebEntry('http://127.0.0.1:8890');
  const r=await app.request('/');expect(r.status).toBe(302);expect(r.headers.get('location')).toBe('http://127.0.0.1:8890/');
  for(const [path,method] of [['/api/sessions','POST'],['/api/settings','PUT'],['/api/workspace','GET'],['/api/desktop/computer/enable','POST']])expect((await app.request(path!,{method})).status).toBe(410);
 });
 it('rejects credential-bearing and non-http control endpoints',()=>{for(const url of ['file:///tmp','http://user:secret@host','bad'])expect(()=>createWebEntry(url)).toThrow();});
});
