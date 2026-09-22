import { redactSecretsForDisplay } from "../lib/remote-retry";
import "./approval-preview.css";
/** Human-readable operation data. This is a preview, never evidence the operation ran. */
export function ApprovalPreview({tool,args}:{tool:string;args:Record<string,unknown>}) {
 const text=(value:unknown)=>redactSecretsForDisplay(String(value??""));
 const titles:Record<string,string>={write_file:"写入文件",edit_file:"替换文件内容",apply_patch:"应用文件修改",delete_file:"删除文件",move_file:"移动文件",run_shell:"执行命令",http_fetch:"访问网络"};
 const target=tool==="move_file"?`${text(args.from)} → ${text(args.to)}`:text(args.path||args.url||"");
 return <div className="approval-preview"><div className="approval-target"><strong>{titles[tool]||tool}</strong>{target&&<code>{target}</code>}</div>
 {tool==="write_file"&&<pre aria-label="待写入内容">{text(args.content)}</pre>}
 {tool==="run_shell"&&<pre aria-label="待执行命令">{text(args.command)}</pre>}
 {tool==="edit_file"&&<div className="approval-change"><div><small>替换前</small><pre>{text(args.old_string)}</pre></div><div><small>替换后</small><pre>{text(args.new_string)}</pre></div></div>}
 {tool==="apply_patch"&&<pre aria-label="待应用修改">{text(args.patch||JSON.stringify(args.replacements,null,2))}</pre>}
 {tool==="delete_file"&&<p>此操作将删除上面的文件。</p>}
 <details><summary>技术参数</summary><pre>{redactSecretsForDisplay(JSON.stringify(args,null,2))}</pre></details></div>
}
