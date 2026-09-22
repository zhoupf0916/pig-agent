import {beforeEach,describe,it,expect,vi} from "vitest";
import {Hono} from "hono";
import type {CloudEnv} from "./types.ts";
const state=vi.hoisted(()=>({owner:"alice",files:[] as {path:string;content:string}[],queries:[] as string[]}));
vi.mock("./db.ts",()=>{
 const query=async(sql:string,args:unknown[]=[])=>{
  state.queries.push(sql);
  if(sql.includes("INSERT INTO project_workspace_files")) {
   if(args[1]!==state.owner) return {rows:[],rowCount:0};
   state.files=JSON.parse(args[2] as string);return {rows:[{project_id:args[0]}],rowCount:1};
  }
  if(sql.includes("SELECT f.files")) return {rows:args[1]===state.owner?[{files:state.files}]:[]};
  return {rows:[],rowCount:0};
 };
 return {db:{query},hash:(x:string)=>x};
});
import {workspaceFilesSchema,loadProjectFiles,seedManifest} from "./project-files.ts";
import {registerCollaborationRoutes} from "./collaboration.ts";
function app(actor:string) {
 const app=new Hono<CloudEnv>();
 app.use("*",async(c,next)=>{c.set("principal",{id:actor,name:actor,role:"member"});await next();});
 registerCollaborationRoutes(app);return app;
}
beforeEach(()=>{state.owner="alice";state.files=[];state.queries=[];});
describe("project directory imports",()=>{
 it("supports nested UTF-8 sources and manifest without contents",()=>{
  const files=[{path:"src/你好.ts",content:"export const answer = 42;"},{path:"README.md",content:"hi"}];
  expect(workspaceFilesSchema.parse(files)).toEqual(files);
  expect(seedManifest(files)).toEqual({fileCount:2,byteSize:27,files:["src/你好.ts","README.md"]});
 });
 it.each(["../secret","/etc/passwd","src/../../etc/passwd","a\\b","src//x",".git/config","sub/.env.production",".ssh/authorized_keys","id_rsa","config.key",".npmrc","node_modules/p/a.js","secrets.json","src/credentials.json"])("rejects dangerous or sensitive path %s",path=>{
  expect(workspaceFilesSchema.safeParse([{path,content:"x"}]).success).toBe(false);
 });
 it("bounds payloads, rejects binary, duplicate and conflicting paths",()=>{
  const validate=(files:unknown)=>workspaceFilesSchema.safeParse(files).success;
  expect(validate([{path:"a",content:"\0"}])).toBe(false);
  expect(validate([{path:"a",content:"好".repeat(70000)}])).toBe(false);
  expect(validate(Array.from({length:401},(_,i)=>({path:`a${i}`,content:""})))).toBe(false);
  expect(validate(Array.from({length:11},(_,i)=>({path:`a${i}`,content:"x".repeat(200000)})))).toBe(false);
  expect(validate([{path:"src",content:""},{path:"src/a",content:""}])).toBe(false);
  expect(validate([{path:"A",content:""},{path:"a",content:""}])).toBe(false);
 });
 it("writes only personal owner seed and never returns file bodies in response",async()=>{
  const request=()=>({method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({files:[{path:"src/test.txt",content:"private"}]})});
  expect((await app("bob").request("/v1/projects/project_x/workspace/files",request())).status).toBe(404);
  const result=await app("alice").request("/v1/projects/project_x/workspace/files",request());
  expect(result.status).toBe(200);expect(JSON.stringify(await result.json())).not.toContain("private");
  expect(await loadProjectFiles("project_x","alice")).toEqual([{path:"src/test.txt",content:"private"}]);
  expect(await loadProjectFiles("project_x","bob")).toEqual([]);
  expect(state.queries.some(sql=>sql.includes("space_id IS NULL"))).toBe(true);
 });
 it("rejects invalid uploads before writing storage",async()=>{
  const result=await app("alice").request("/v1/projects/project_x/workspace/files",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({files:[{path:".env",content:"secret"}]})});
  expect(result.status).toBe(400);expect(state.queries).toEqual([]);
 });
});
