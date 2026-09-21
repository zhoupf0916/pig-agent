// Run on macOS: swift scripts/make-desktop-icon.swift
import AppKit
import Foundation
let output = "apps/desktop/assets/AppIcon.iconset"
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let pixels = size * scale
    let image = NSImage(size: NSSize(width: pixels, height: pixels))
    image.lockFocus()
    let factor = CGFloat(pixels) / 1024
    let transform = NSAffineTransform(); transform.scale(by: factor); transform.concat()
    NSColor(calibratedRed: 0.15, green: 0.36, blue: 0.28, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 195, yRadius: 195).fill()
    let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 620, weight: .semibold), .foregroundColor: NSColor.white, .paragraphStyle: paragraph]
    ("P" as NSString).draw(in: NSRect(x: 72, y: 152, width: 880, height: 730), withAttributes: attributes)
    image.unlockFocus()
    let representation = NSBitmapImageRep(data: image.tiffRepresentation!)!
    let suffix = scale == 2 ? "@2x" : ""
    try representation.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(output)/icon_\(size)x\(size)\(suffix).png"))
  }
}
