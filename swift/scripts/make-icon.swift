// Renders the app icon: a white rook on a green board-like tile.
// Usage: swift scripts/make-icon.swift <rook.svg> <AppIcon.appiconset>
import AppKit

let args = CommandLine.arguments
let rook = NSImage(contentsOfFile: args[1])!
let out = args[2]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let inset = s * 0.098
    let tile = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
    shadow.shadowBlurRadius = s * 0.03
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.012)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    NSColor(red: 0.2, green: 0.4, blue: 0.27, alpha: 1).setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    shape.addClip()
    NSGradient(colors: [NSColor(red: 0.42, green: 0.66, blue: 0.47, alpha: 1),
                        NSColor(red: 0.16, green: 0.36, blue: 0.24, alpha: 1)])!.draw(in: tile, angle: -90)
    // A faint 4x4 chequer pattern.
    let cell = tile.width / 4
    NSColor.white.withAlphaComponent(0.07).setFill()
    for r in 0..<4 { for c in 0..<4 where (r + c) % 2 == 0 {
        NSRect(x: tile.minX + CGFloat(c) * cell, y: tile.minY + CGFloat(r) * cell, width: cell, height: cell).fill()
    } }
    let glyph = tile.insetBy(dx: tile.width * 0.13, dy: tile.width * 0.13)
    let drop = NSShadow()
    drop.shadowColor = NSColor.black.withAlphaComponent(0.35)
    drop.shadowBlurRadius = s * 0.025
    drop.shadowOffset = NSSize(width: 0, height: -s * 0.015)
    drop.set()
    rook.draw(in: glyph, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

var images: [String] = []
for (pt, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = "icon_\(pt)x\(pt)@\(scale)x.png"
    try! render(pt * scale).write(to: URL(fileURLWithPath: "\(out)/\(name)"))
    images.append("{\"filename\":\"\(name)\",\"idiom\":\"mac\",\"scale\":\"\(scale)x\",\"size\":\"\(pt)x\(pt)\"}")
}
let json = "{\"images\":[\(images.joined(separator: ","))],\"info\":{\"author\":\"xcode\",\"version\":1}}"
try! json.write(toFile: "\(out)/Contents.json", atomically: true, encoding: .utf8)
