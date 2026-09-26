import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Expert, type SkillMeta, ECOSYSTEM_CATALOG, validateSkillPackFiles } from "@pig-agent/contracts";
import { createApp } from "../app.ts";

const ids = ["api-workshop", "release-review", "data-quality", "meeting-actions"];
describe("practical capability packs", () => {
  it.each(ids)("%s installs disabled and exposes a bound expert and resources only after enabling", async id => {
    const app = createApp();
    const installed = await app.request(`/api/plugins/catalog/${id}`, { method: "POST" });
    expect(installed.status).toBe(201);
    const before = await (await app.request('/api/experts')).json() as {experts: Expert[]};
    expect(before.experts.some((e: { id: string }) => e.id.startsWith(`plugin_${id}_`))).toBe(false);
    expect((await app.request(`/api/plugins/${id}`, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({enabled:true}) })).status).toBe(200);
    const { experts } = await (await app.request('/api/experts')).json() as {experts: Expert[]};
    const { skills } = await (await app.request('/api/skills')).json() as {skills: SkillMeta[]};
    const expert = experts.find((e: { id: string }) => e.id.startsWith(`plugin_${id}_`));
    expect(expert!.skillIds).toHaveLength(1);
    expect(skills.some((s: {name: string}) => s.name === expert!.skillIds[0])).toBe(true);
    const pack = ECOSYSTEM_CATALOG.find(p => p.id === id)!;
    expect(validateSkillPackFiles(pack.skills[0]!.files!)).toBeNull();
    expect(pack.skills[0]!.files!.some(f=> f.path.endsWith('.py'))).toBe(true);
    expect((await app.request(`/api/plugins/catalog/${id}`, {method:'POST'})).status).toBe(409);
  });
  it.each([
    ['api-workshop','spec.json',JSON.stringify({paths:{'/health':{get:{}},'/items':{post:{},parameters:[]}}}), '"operations": 2'],
    ['release-review','results.json',JSON.stringify([{name:'build',status:'passed'},{name:'rollback',status:'missing'}]), '"ready": false'],
    ['data-quality','rows.csv','name,amount\n甲,10\n甲,10\n乙,\n', '"duplicate_rows": 1'],
    ['meeting-actions','meeting.md','讨论内容\n- [ ] 张三：核对部署说明（周五前）\n- [x] 已完成检查\n', '"pending": 1'],
  ])("%s script computes evidence from input without modifying the file", async (id, name, input, expected) => {
    const pack = ECOSYSTEM_CATALOG.find(p=>p.id===id);
    expect(pack).toBeDefined();
    const script = pack!.skills[0]!.files!.find(f=>f.path.endsWith('.py'))!;
    const dir = await mkdtemp(join(tmpdir(),'pig-pack-'));
    const path = join(dir, name); await writeFile(path,input);
    const output = spawnSync('python3', ['-c',script.content,path], {encoding:'utf8',timeout:5000});
    expect(output.status,output.stderr).toBe(0);
    expect(output.stdout).toContain(expected);
    const {readFile} = await import('node:fs/promises');
    expect(await readFile(path,'utf8')).toBe(input);
    const invalid=spawnSync('python3',['-c',script.content,join(dir,'missing')],{encoding:'utf8',timeout:5000});
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('无法分析');
  });
});
