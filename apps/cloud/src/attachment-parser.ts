import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
const exec = promisify(execFile);
export const ATTACHMENT_LIMIT = 4 * 1024 * 1024;
export type ParsedAttachment = { mime: string; kind: "text" | "pdf" | "docx" | "image"; text?: string; warning?: string };
const DOCX = `import zipfile,sys,xml.etree.ElementTree as ET,resource
resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(4,4))
with zipfile.ZipFile(sys.argv[1]) as z:
 infos=z.infolist()
 if len(infos)>2000 or sum(i.file_size for i in infos)>16*1024*1024: raise ValueError('Document expansion limit')
 info=z.getinfo('word/document.xml')
 if info.file_size>2*1024*1024: raise ValueError('Document text limit')
 data=z.read(info)
 if b'<!DOCTYPE' in data or b'<!ENTITY' in data: raise ValueError('XML entities forbidden')
 root=ET.fromstring(data)
 print('\\n'.join(''.join(t.text or '' for t in p.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')) for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p')))
`;
export async function parseAttachment(name: string, data: Buffer): Promise<ParsedAttachment> {
  if (!data.length || data.length > ATTACHMENT_LIMIT) throw Error("文件为空或超过 4 MiB 上限");
  const ext = extname(name).toLowerCase();
  const imageMime = data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg" : /^GIF8[79]a/.test(data.subarray(0,6).toString()) ? "image/gif" : data.subarray(0,4).toString() === "RIFF" && data.subarray(8,12).toString() === "WEBP" ? "image/webp" : undefined;
  if (imageMime) return { mime: imageMime, kind: "image", warning: "图片原件将交付工作区；当前模型未启用视觉识别，不会自动识别图片内容。" };
  if ([".txt",".md",".csv",".json",".jsonl",".yaml",".yml",".xml",".html",".css",".js",".ts",".tsx",".jsx",".py",".sh",".log",".sql"].includes(ext)) {
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw Error("文本文件必须是 UTF-8 编码"); }
    if (text.includes("\0")) throw Error("文件包含二进制内容，不能作为文本解析");
    if (text.length > 200000) throw Error("文本超过 200000 字符，请拆分文件");
    return { mime: "text/plain; charset=utf-8", kind: "text", text };
  }
  const pdf = ext === ".pdf" && data.subarray(0,5).toString() === "%PDF-";
  const docx = ext === ".docx" && data.subarray(0,4).equals(Buffer.from([80,75,3,4]));
  if (!pdf && !docx) throw Error("不支持此格式或文件内容与扩展名不匹配；支持文本、PDF、DOCX、PNG、JPEG、GIF、WebP");
  const dir = await mkdtemp(join(tmpdir(), "pig-attachment-"));
  try {
    const file = join(dir, pdf ? "source.pdf" : "source.docx"); await writeFile(file, data, { mode: 0o600 });
    const command = pdf ? "python3" : "python3";
    const args = pdf ? ["-c", "import os,resource,sys;resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024));resource.setrlimit(resource.RLIMIT_CPU,(4,4));os.execvp('pdftotext',['pdftotext','-f','1','-l','100','-layout',sys.argv[1],'-'])", file] : ["-c", DOCX, file];
    const result = await exec(command, args, { timeout: 8000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" } });
    const text = result.stdout.trim();
    if (!text) throw Error("未提取到可读文字；扫描 PDF 暂不支持 OCR，请提供文本版本");
    if (text.length > 200000) throw Error("提取文本超过 200000 字符，请拆分文件");
    return { mime: pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: pdf ? "pdf" : "docx", text, warning: pdf ? "PDF 提取前 100 页的文本，不含图片识别；复杂排版请核对原件。" : "已提取 DOCX 正文文本，不包含图片及批注。" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error("文档解析服务未安装，请联系管理员安装 python3 和 poppler-utils");
    if (error instanceof Error && !('stderr' in error)) throw error;
    throw Error("文档解析失败或超出资源限制，请检查文件是否损坏、加密或过大");
  } finally { await rm(dir, { recursive: true, force: true }); }
}
