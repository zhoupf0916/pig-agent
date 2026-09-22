// Fixed native program: parameters arrive as JSON on stdin, never as shell code.
module.exports = String.raw`
import Cocoa
import ApplicationServices
let data = FileHandle.standardInput.readDataToEndOfFile()
let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
let action = input["action"] as? String ?? "status"
func output(_ value: [String: Any]) { let d = try! JSONSerialization.data(withJSONObject: value); print(String(data:d,encoding:.utf8)!) }
let requested = input["appName"] as? String
let front = requested == nil ? NSWorkspace.shared.frontmostApplication : NSWorkspace.shared.runningApplications.first { $0.localizedName?.caseInsensitiveCompare(requested!) == .orderedSame }
if requested != nil && front == nil { output(["error":"未找到正在运行的目标应用，请先打开应用并使用准确名称。"]); exit(0) }
if action == "status" {
 output(["accessibility": AXIsProcessTrusted(), "pid": front?.processIdentifier ?? 0, "app": front?.localizedName ?? "Unknown"])
 exit(0)
}
guard AXIsProcessTrusted() else { output(["error":"请在 macOS 隐私与安全性 → 辅助功能中授权 Pig Agent（开发模式为 Electron），然后重试。"]); exit(0) }
let pid = Int32(input["pid"] as? Int ?? 0)
guard let target = NSRunningApplication(processIdentifier: pid) else { output(["error":"目标应用已关闭，请重新观察。"]); exit(0) }
if action == "observe" {
 let root = AXUIElementCreateApplication(pid)
 var rows: [[String:Any]] = []
 func attr(_ el: AXUIElement, _ key: String) -> CFTypeRef? { var value: CFTypeRef?; AXUIElementCopyAttributeValue(el,key as CFString,&value); return value }
 func visit(_ el: AXUIElement, _ depth: Int) {
  if depth > 8 || rows.count >= 180 { return }
  let role = attr(el,kAXRoleAttribute) as? String ?? ""
  let title = attr(el,kAXTitleAttribute) as? String ?? ""
  let description = attr(el,kAXDescriptionAttribute) as? String ?? ""
  let secure = (attr(el,kAXSubroleAttribute) as? String ?? "") == "AXSecureTextField"
  let value = secure ? "[protected]" : (attr(el,kAXValueAttribute) as? String ?? "")
  var row: [String:Any] = ["role":role,"title":String(title.prefix(250)),"description":String(description.prefix(250)),"value":String(value.prefix(800))]
  if let v = attr(el,kAXPositionAttribute), CFGetTypeID(v) == AXValueGetTypeID() { var point = CGPoint.zero; AXValueGetValue(v as! AXValue,.cgPoint,&point); row["x"] = point.x; row["y"] = point.y }
  if let v = attr(el,kAXSizeAttribute), CFGetTypeID(v) == AXValueGetTypeID() { var size = CGSize.zero; AXValueGetValue(v as! AXValue,.cgSize,&size); row["width"] = size.width; row["height"] = size.height }
  rows.append(row)
  if let children = attr(el,kAXChildrenAttribute) as? [AXUIElement] { for child in children { visit(child,depth+1) } }
 }
 visit(root,0); output(["app":target.localizedName ?? "Unknown","pid":pid,"elements":rows]); exit(0)
}
target.activate(options: []); Thread.sleep(forTimeInterval:0.25)
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { output(["error":"目标应用无法激活，已拒绝输入；请重新观察。"]); exit(0) }
if action == "click" {
 let point = CGPoint(x: input["x"] as? Double ?? 0,y: input["y"] as? Double ?? 0)
 var windowsValue: CFTypeRef?
 AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &windowsValue)
 let windows = windowsValue as? [AXUIElement] ?? []
 let allowed = windows.contains { window in
  var pv: CFTypeRef?, sv: CFTypeRef?
  AXUIElementCopyAttributeValue(window,kAXPositionAttribute as CFString,&pv)
  AXUIElementCopyAttributeValue(window,kAXSizeAttribute as CFString,&sv)
  guard let pv=pv, let sv=sv, CFGetTypeID(pv)==AXValueGetTypeID(), CFGetTypeID(sv)==AXValueGetTypeID() else { return false }
  var p=CGPoint.zero; var z=CGSize.zero
  AXValueGetValue(pv as! AXValue,.cgPoint,&p); AXValueGetValue(sv as! AXValue,.cgSize,&z)
  return CGRect(origin:p,size:z).contains(point)
 }
 guard allowed else { output(["error":"坐标不在已观察应用窗口内，已拒绝点击；请重新观察。"]); exit(0) }
 CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
 CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
} else if action == "type" {
 let text = input["text"] as? String ?? ""
 for character in text { let chunk = Array(String(character).utf16); for down in [true,false] { let e = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down); e?.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:chunk); e?.post(tap:.cghidEventTap) } }
} else if action == "key" {
 let codes: [String:CGKeyCode] = ["enter":36,"tab":48,"escape":53,"backspace":51,"up":126,"down":125,"left":123,"right":124]
 if let code = codes[input["key"] as? String ?? ""] { for down in [true,false] { CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down)?.post(tap:.cghidEventTap) } }
} else if action == "scroll" {
 var focused: CFTypeRef?
 AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),kAXFocusedWindowAttribute as CFString,&focused)
 guard let focused=focused, CFGetTypeID(focused)==AXUIElementGetTypeID() else { output(["error":"目标应用没有可滚动窗口，请重新观察。"]); exit(0) }
 var pv: CFTypeRef?, sv: CFTypeRef?
 AXUIElementCopyAttributeValue(focused as! AXUIElement,kAXPositionAttribute as CFString,&pv)
 AXUIElementCopyAttributeValue(focused as! AXUIElement,kAXSizeAttribute as CFString,&sv)
 guard let pv=pv, let sv=sv, CFGetTypeID(pv)==AXValueGetTypeID(), CFGetTypeID(sv)==AXValueGetTypeID() else { output(["error":"无法确定目标窗口边界，已拒绝滚动。"]); exit(0) }
 var position=CGPoint.zero; var size=CGSize.zero
 AXValueGetValue(pv as! AXValue,.cgPoint,&position); AXValueGetValue(sv as! AXValue,.cgSize,&size)
 let center=CGPoint(x:position.x+size.width/2,y:position.y+size.height/2)
 CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:center,mouseButton:.left)?.post(tap:.cghidEventTap)
 let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:1,wheel1:Int32(input["delta"] as? Int ?? 0),wheel2:0,wheel3:0)
 event?.location=center; event?.post(tap:.cghidEventTap)
}
output(["ok":true,"app":target.localizedName ?? "Unknown"])
`;
