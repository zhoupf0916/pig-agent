import { z } from "zod";
import { db } from "./db.ts";

// Browser directory selection is a copy, never a grant to access the user's disk.
export const workspaceFilesSchema = z.array(z.object({
  path: z.string().min(1).max(240).refine(path => {
    const parts = path.split("/");
    return !/[\\\x00-\x1f:]/.test(path) && parts.every(part =>
      part !== "" && part !== "." && part !== ".." &&
      !/^(\.git|\.ssh|\.aws|\.azure|\.gcloud|node_modules|\.venv|venv|dist|build)$/i.test(part) &&
      !/^\.env/i.test(part) &&
      !/^(id_(rsa|dsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?|\.npmrc|\.pypirc|\.netrc)$/i.test(part) &&
      !/\.(pem|key|p12|pfx|keystore)$/i.test(part));
  }, "路径无效或包含敏感文件、依赖及构建目录"),
  content: z.string().refine(s => Buffer.byteLength(s,"utf8") <= 200000 && !s.includes("\0"), "仅支持不超过 200 KB 的 UTF-8 文本文件"),
}).strict()).max(400).superRefine((files, ctx) => {
  if (files.reduce((sum,file) => sum + Buffer.byteLength(file.content,"utf8"),0) > 2 * 1024 * 1024)
    ctx.addIssue({code:"custom", message:"工作区文件总大小不能超过 2 MB"});
  const paths = new Set<string>();
  for(const file of files) {
    const path = file.path.normalize("NFC").toLowerCase();
    if(paths.has(path)) ctx.addIssue({code:"custom",message:"工作区包含重复文件路径"});
    paths.add(path);
  }
  for(const path of paths) {
    const parts = path.split("/");
    for(let i=1;i<parts.length;i++) if(paths.has(parts.slice(0,i).join("/")))
      ctx.addIssue({code:"custom",message:"文件与目录路径冲突"});
  }
});
export type WorkspaceFile = z.infer<typeof workspaceFilesSchema>[number];
export function seedManifest(files: WorkspaceFile[]) {
  return {fileCount:files.length,byteSize:files.reduce((sum,f)=>sum+Buffer.byteLength(f.content,"utf8"),0),files:files.map(f=>f.path)};
}
export async function loadProjectFiles(projectId: string | undefined, actor: string, client: Pick<typeof db,"query"> = db): Promise<WorkspaceFile[]> {
  if(!projectId) return [];
  const row=(await client.query(`SELECT f.files FROM project_workspace_files f JOIN shared_projects p ON p.id=f.project_id WHERE p.id=$1 AND p.owner_id=$2 AND p.space_id IS NULL`,[projectId,actor])).rows[0];
  return row?.files || [];
}
