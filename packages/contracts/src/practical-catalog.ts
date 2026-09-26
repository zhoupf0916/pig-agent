import type { EcosystemPlugin } from "./ecosystem.js";

// Original Chinese playbooks; scripts are reviewed resources, never install hooks.
const boundary = "\n\n权限：仅处理用户提供或获准工作区中的材料。脚本只读输入并输出统计，不联网、不安装依赖。执行时按技能加载返回的资源目录解析 scripts/ 路径，不假设当前工作区就是技能目录。执行脚本仍遵守当前沙箱与审批；不自动发布、提交或发送消息。默认中文交付，区分实测、推断和未验证项。";
const python = (body: string) => `"""Pig Agent 原创只读分析助手。Python 3 标准库，无第三方依赖。"""
import sys, json, csv, re
from pathlib import Path

def main():
    if len(sys.argv) != 2:
        print("用法：python3 本脚本.py <输入文件>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    try:
        if path.stat().st_size > 5 * 1024 * 1024:
            raise ValueError("输入超过 5 MiB，请先缩小范围")
        text = path.read_text(encoding="utf-8-sig")
${body.split('\n').map(line => '        ' + line).join('\n')}
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (OSError, ValueError, TypeError, KeyError, csv.Error) as error:
        print("无法分析：" + str(error), file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
`;
function pack(id: string, name: string, description: string, expertName: string, body: string, script: string, code: string, reference: string, template: string): EcosystemPlugin {
  const skillId = `${id}-guide`;
  return {
    id, name, description, version: "1.0.0", purpose: "Pig Agent 原创中文工作包；包含只读 Python 助手、参考标准和交付模板。",
    skills: [{ id: skillId, name, description, body: body + boundary,
      files: [
        {path:`scripts/${script}.py`, content:python(code)},
        {path:'references/checklist.md', content:reference},
        {path:'assets/report-template.md', content:template},
      ],
    }],
    experts:[{id:`${id}-expert`,name:expertName,description,
      instruction:`你是${expertName}，默认用中文工作。先明确输入、目标和验收口径，按绑定技能读取必要参考并执行可复现检查，最后按模板交付证据、限制与下一步。不得把模拟结果写成真实系统结果，不因扮演专家扩大工具权限。${boundary}`,
      skillIds:[skillId]}],
  };
}
export const PRACTICAL_CATALOG: EcosystemPlugin[] = [
  pack("api-workshop", "API 契约体检", "检查 OpenAPI 路由、错误响应和鉴权声明，交付接口问题清单与复现步骤。", "接口排障工程师",
    "## 适用场景\n接口联调、SDK 接入前检查、OpenAPI JSON 审阅。\n## 输入\n用户提供的 OpenAPI JSON、问题接口与预期行为；不要擅自访问生产接口。\n## 步骤\n1. 读取 references/checklist.md，先确认规范版本和鉴权要求。\n2. 使用 python3 scripts/inspect_openapi.py <spec.json> 汇总路由与显式响应/鉴权缺口。仅支持 JSON；YAML 需先在获准工具中转换，不假装支持。\n3. 核对顶层和操作级 security 的继承，区分未声明与有意公开。\n4. 逐条读取相关 schema，写出最小请求与预期响应，联网复现需审批。\n## 交付\n参照 assets/report-template.md 输出接口清单、证据与待核实项。\n## 验证\n统计数与路径逐一对应；没有真实请求时明确标注静态检查。",
    "inspect_openapi", `spec = json.loads(text)
if not isinstance(spec, dict) or not isinstance(spec.get("paths"), dict):
    raise ValueError("需要包含 paths 对象的 OpenAPI JSON")
operations = []
for path_name, item in spec["paths"].items():
    if not isinstance(item, dict):
        continue
    for method, operation in item.items():
        if method.lower() not in ("get", "post", "put", "patch", "delete", "head", "options", "trace") or not isinstance(operation, dict):
            continue
        security = operation.get("security", spec.get("security"))
        operations.append({"path": path_name, "method": method.upper(), "responses": list(operation.get("responses", {})), "security_declared": security is not None, "public": security == []})
result = {"operations": len(operations), "items": operations, "note": "只做静态盘点，不解析外部引用，不代表接口可用或安全"}`,
    "# 接口核对标准\n- 顶层 security 可被操作覆盖；缺少声明不等于确认漏洞。\n- 检查必填参数、枚举、分页、错误码与重试语义。\n- 外部 $ref 不自动下载。\n- 网络复现需获准，不携带真实令牌到报告。\n",
    "# API 契约体检\n## 输入与规范版本\n## 路由盘点\n## 问题（路径 / 证据 / 影响 / 建议）\n## 已执行验证\n## 未验证项\n"),
  pack("release-review", "发布就绪检查", "汇总构建、测试、迁移与回滚证据，避免把未验证项目当作通过。", "发布验收负责人",
    "## 适用场景\n发布前验收、版本交付与回滚演练准备。\n## 输入\n版本标识、变更范围、现有测试报告和回滚步骤。\n## 步骤\n1. 按 references/checklist.md 收集证据。\n2. 把检查整理为 JSON 数组，每项包含 name 与 status（passed / failed / missing）。\n3. 用 python3 scripts/check_release.py <results.json> 汇总。脚本只核对清单，不执行部署，不验证声明真假。\n4. 缺少构建、测试、迁移或回滚证据时补齐或明确阻断，不替用户编造通过。\n## 交付\n使用 assets/report-template.md，列阻断项、回滚入口与验收人待确认项。\n## 验证\n每个 passed 都有真实命令/环境/结果来源；发布动作需要单独授权。",
    "check_release", `rows = json.loads(text)
if not isinstance(rows, list) or any(not isinstance(r, dict) or not isinstance(r.get("name"), str) or not r["name"].strip() or r.get("status") not in ("passed", "failed", "missing") for r in rows):
    raise ValueError("需要包含 name 和 passed/failed/missing status 的 JSON 数组")
names = [r["name"].strip() for r in rows]
if len(set(names)) != len(names):
    raise ValueError("检查名称重复，请合并证据")
required = ("build", "tests", "migration", "rollback")
missing = [name for name in required if name not in names]
blocked = [r["name"] for r in rows if r["status"] != "passed"]
result = {"ready": bool(rows) and not missing and not blocked, "missing_required": missing, "blocked": blocked, "checks": len(rows), "note": "就绪仅表示输入清单完整通过；不等于已部署或证据已被独立验证"}`,
    "# 发布证据\n必需项标识：build、tests、migration、rollback。无迁移时也记录 migration 的不适用理由与核验。每项注明版本、环境、命令和结果。失败不得改成 missing 掩盖。回滚需要说明数据库兼容性和运行任务如何处理。\n",
    "# 发布验收\n## 版本与范围\n## 检查证据\n| 项目 | 状态 | 环境与证据 |\n| --- | --- | --- |\n## 阻断项\n## 回滚与数据兼容\n## 未执行的操作\n"),
  pack("data-quality", "CSV 数据质量", "检查缺失、重复与列宽异常，生成可复核的数据清理建议。", "数据核验专家",
    "## 适用场景\n导入 CSV 前体检、报表数字核对、数据清理规划。\n## 输入\nUTF-8 CSV、字段含义、允许缺失规则与唯一键；不明确的业务口径单独标注。\n## 步骤\n1. 先读 references/checklist.md。\n2. 执行 python3 scripts/check_csv.py <data.csv>，获取行数、空值、重复和列宽异常。\n3. 区分全行重复与业务主键冲突，不自动删除任何一行。\n4. 有异常时定位原始行并提出清理方案，用户授权后才创建清理副本。\n## 交付\n使用 assets/report-template.md，说明输入大小、异常数量、口径与修复建议。\n## 验证\n重算行数，确认输入未改写；空白字符串按缺失处理，不推断因果。",
    "check_csv", `import io
rows = list(csv.reader(io.StringIO(text)))
if not rows or not rows[0] or any(not c.strip() for c in rows[0]) or len(set(rows[0])) != len(rows[0]):
    raise ValueError("CSV 必须有非空且不重复的表头")
header, values = rows[0], rows[1:]
seen, duplicate = set(), 0
for row in values:
    key = tuple(row)
    if key in seen:
        duplicate += 1
    seen.add(key)
result = {"rows": len(values), "columns": len(header), "duplicate_rows": duplicate, "ragged_rows": sum(len(row) != len(header) for row in values), "missing": {name: sum(i >= len(row) or not row[i].strip() for row in values) for i, name in enumerate(header)}}`,
    "# 数据质量口径\n全行重复按原始字段精确比较，空白统计按 strip 后为空。列宽异常包含多列与少列。脚本不判断业务唯一键、不推断类型、不删除数据。遇到引号、多行字段和BOM须保留CSV解析语义。输入上限5MiB。\n",
    "# 数据质量报告\n## 数据范围与字段口径\n## 行列与异常统计\n## 原始行证据\n## 清理建议（不自动修改）\n## 复核方法与限制\n"),
  pack("meeting-actions", "会议行动整理", "从会议记录提炼决定、待办和待确认问题，核对负责人和截止时间。", "会议行动协调员",
    "## 适用场景\n会议纪要、访谈整理和跨团队交接。\n## 输入\n用户提供的记录、会议日期和已知参与者。\n## 步骤\n1. 阅读 references/checklist.md，区分讨论、决定与承诺。\n2. 按 assets/report-template.md 起草纪要，待办写成 Markdown 复选框；未明确负责人或日期标为待确认。\n3. 若用户授权保存草稿，再执行 python3 scripts/count_actions.py <notes.md> 检查复选框数量与行号。脚本只统计已有复选框，不从自然语言推断行动。\n4. 逐条回指原始发言，不替任何人承诺。\n## 交付\n中文纪要、行动清单与待确认事项；不自动发邮件或创建外部任务。\n## 验证\n已完成和未完成状态与原文一致；引用逐项可追溯。",
    "count_actions", `items = []
for number, line in enumerate(text.splitlines(), 1):
    match = re.match(r"^\\s*[-*] \\[([ xX])\\]\\s+(.+)$", line)
    if match:
        items.append({"line": number, "done": match.group(1).lower() == "x", "text": match.group(2)})
result = {"pending": sum(not row["done"] for row in items), "completed": sum(row["done"] for row in items), "items": items}`,
    "# 会议整理标准\n讨论不等于决定，建议不等于承诺。负责人/截止日期不得猜测；相对时间结合会议日期核对。敏感发言只在授权范围内分享。统计脚本只识别 Markdown - [ ] / - [x]，不会自动理解自然语言。\n",
    "# 会议纪要\n## 日期、参与者与来源\n## 已确认决定\n## 行动清单\n- [ ] 待办（负责人：待确认；截止：待确认；来源：待补充）\n## 未决问题\n## 核对记录\n"),
];
