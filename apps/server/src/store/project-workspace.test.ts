import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createApp } from "../app.ts";
import { createProject, updateProject, deleteProject, validateProjectWorkspace } from "./projects.ts";
import { createSession, deleteSession } from "./sessions.ts";
import { saveSessionArtifactToProject } from "./artifacts-to-project.ts";
import { readAssetBytes } from "./asset-preview.ts";
import { loadSessionSettings } from "./settings.ts";

describe("project workspace binding",()=>{
  it("captures a directory for existing tasks and applies changes only to new tasks",async()=>{
    const a=await realpath(await mkdtemp(join(tmpdir(),"pig-project-a-")));
    const b=await realpath(await mkdtemp(join(tmpdir(),"pig-project-b-")));
    const project=await createProject({name:"目录边界",workspaceRoot:a});
    const first=await createSession({projectId:project.id});
    await updateProject(project.id,{workspaceRoot:b});
    const second=await createSession({projectId:project.id});
    try {
      await writeFile(join(a,"project-proof.txt"),"original project workspace");
      expect((await loadSessionSettings(first)).workspaceRoot).toBe(a);
      expect((await loadSessionSettings(second)).workspaceRoot).toBe(b);
      const response=await createApp().request(`/api/sessions/${first.id}/workbench`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as {currentRoot:string}).currentRoot).toBe(a);
      const tree=await createApp().request(`/api/workspace/tree?sessionId=${first.id}`);
      expect(((await tree.json()) as {root:string}).root).toBe(a);
      const file=await createApp().request(`/api/workspace/file?sessionId=${first.id}&path=project-proof.txt`);
      expect(file.status).toBe(200);
      expect(await file.text()).toContain("original project workspace");
      const other=await createApp().request(`/api/workspace/file?sessionId=${second.id}&path=project-proof.txt`);
      expect(other.status).toBe(400);
      first.artifacts=[{path:"project-proof.txt",action:"created",updatedAt:new Date().toISOString()}];
      const saved=await saveSessionArtifactToProject(first,"project-proof.txt");
      expect((await readAssetBytes(project.id,saved.asset))?.toString()).toBe("original project workspace");
    } finally {await deleteSession(first.id);await deleteSession(second.id);await deleteProject(project.id);await rm(a,{recursive:true,force:true});await rm(b,{recursive:true,force:true});}
  });
  it("rejects relative and missing directories at the HTTP boundary",async()=>{
    const app=createApp();
    for(const workspaceRoot of ["relative/path","/definitely-missing-pig-workspace"]){
      const response=await app.request("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"invalid",workspaceRoot})});
      expect(response.status).toBe(400);
    }
    expect(await validateProjectWorkspace("")).toBeUndefined();
  });
});
