import { useEffect, useState } from 'react';
type Status={available:boolean;enabled:boolean;accessibility?:boolean;screen?:string;busy?:boolean;screenshotAvailable?:boolean};
export function ComputerPanel(){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState(false);
 async function load(action='status'){setBusy(true);setError('');try{const r=await fetch(`/api/desktop/computer/${action}`,{method:action==='status'?'GET':'POST'});const d=await r.json();if(!r.ok)throw Error(d.error||'无法读取电脑操作状态');setStatus(d);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 useEffect(()=>{void load();},[]);
 return <section aria-label="电脑操作"><p className="settings-scope">让本机 Pig 通过辅助功能读取界面并操作鼠标、输入文字。每次读取或操作都需在桌面确认，可随时撤销。</p>
 {!status&&!error&&<p role="status">正在检查桌面能力…</p>}
 {status&&!status.available&&<p className="settings-note">请在 macOS 桌面客户端使用。网页和远端任务不能操作你的电脑。</p>}
 {status?.available&&<><h4>{status.enabled?'已启用本次应用会话':'电脑操作未启用'}</h4><ul className="settings-status-list"><li><span>{status.accessibility?'已允许':'未允许'}</span><span>系统辅助功能</span></li><li><span>{status.screen==='granted'?'已允许':status.screen||'未确认'}</span><span>系统屏幕录制</span></li></ul><p className="settings-note">系统权限请在 macOS「系统设置 → 隐私与安全性」中管理。本次启用在退出客户端后失效。界面文本会发送给当前模型；截图仅用于本机预览。正式打包版本已内置原生组件。</p><div><button type="button" disabled={busy} className="btn-primary" onClick={()=>void load(status.enabled?'revoke':'enable')}>{busy?'处理中…':status.enabled?'撤销电脑操作':'启用电脑操作'}</button> <button type="button" disabled={busy} className="btn-quiet" onClick={()=>void load()}>重新检查权限</button></div><p className="settings-note">启用后，在本机 Pig 任务中描述要操作的界面。当前支持辅助功能可识别的界面；不支持纯图像识别。模型需要先观察，再请求单次操作。</p></>}
 {status?.screenshotAvailable&&<div><button type="button" className="btn-quiet" onClick={()=>setPreview(!preview)}>{preview?"收起截图":"查看最近截图"}</button>{preview&&<img src="/api/desktop/computer/screenshot" alt="最近一次经授权的屏幕截图" style={{maxWidth:"100%",borderRadius:8}} />}</div>}
 {error&&<p role="alert" className="text-danger">{error}</p>}
 </section>;
}
