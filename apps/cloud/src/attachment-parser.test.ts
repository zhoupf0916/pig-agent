import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMIT, parseAttachment } from "./attachment-parser.ts";
describe("untrusted attachment classification", () => {
  it("uses actual content rather than a user supplied MIME", async () => {
    expect(await parseAttachment("notes.md",Buffer.from("# hello\n世界"))).toMatchObject({kind:"text",text:"# hello\n世界"});
    expect(await parseAttachment("photo.jpg",Buffer.from([137,80,78,71,13,10,26,10]))).toMatchObject({kind:"image",mime:"image/png",warning:expect.stringContaining("未启用视觉")});
  });
  it("rejects extension spoofing, NUL, invalid UTF-8 and unsupported formats", async () => {
    await expect(parseAttachment("fake.pdf",Buffer.from("not pdf"))).rejects.toThrow("不匹配");
    await expect(parseAttachment("binary.txt",Buffer.from([0,1]))).rejects.toThrow("二进制");
    await expect(parseAttachment("bad.txt",Buffer.from([255,254]))).rejects.toThrow("UTF-8");
    await expect(parseAttachment("file.exe",Buffer.from("MZ"))).rejects.toThrow("不支持");
  });
  it("enforces file and extracted text limits before persistence", async () => {
    await expect(parseAttachment("empty.txt",Buffer.alloc(0))).rejects.toThrow("为空");
    await expect(parseAttachment("big.txt",Buffer.alloc(ATTACHMENT_LIMIT+1))).rejects.toThrow("4 MiB");
    await expect(parseAttachment("long.txt",Buffer.alloc(200001,65))).rejects.toThrow("200000");
  });
  it("rejects highly compressed DOCX expansion before parsing XML", async () => {
    const archive=execFileSync("python3",["-c","import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); z.writestr('word/document.xml','A'*(17*1024*1024)); z.close(); sys.stdout.buffer.write(b.getvalue())"],{maxBuffer:1024*1024});
    expect(archive.length).toBeLessThan(100000);
    await expect(parseAttachment("expansion.docx",archive)).rejects.toThrow("解析失败");
  });
  it("does not silently accept a malformed archive", async () => {
    await expect(parseAttachment("broken.docx",Buffer.from([80,75,3,4,0,0,0,0]))).rejects.toThrow("解析失败");
  });
});
