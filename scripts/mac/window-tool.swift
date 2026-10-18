// scripts/mac-window.sh 用的小工具，第一次用时编译到 target/dev-tools/window-tool。
//   window-tool list [pid]                       列出屏幕上的 EverShell 窗口（或指定进程的窗口）
//   window-tool crop 输入 输出 x y 宽 高 窗口宽     按窗口坐标（点）裁图，自动换算 Retina 倍数
import AppKit
import CoreGraphics

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "list":
    let pidFilter = args.count > 2 ? Int(args[2]) : nil
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    for info in infos {
        guard (info[kCGWindowLayer as String] as? Int) == 0 else { continue }
        let owner = info[kCGWindowOwnerName as String] as? String ?? ""
        let pid = info[kCGWindowOwnerPID as String] as? Int ?? 0
        if let want = pidFilter {
            guard pid == want else { continue }
        } else {
            guard owner.lowercased().contains("evershell") else { continue }
        }
        guard let dict = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: dict) else { continue }
        let number = info[kCGWindowNumber as String] as? Int ?? 0
        print("\(number)\t\(pid)\t\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))\t\(owner)")
    }
case "crop":
    guard args.count == 9,
          let x = Double(args[4]), let y = Double(args[5]),
          let w = Double(args[6]), let h = Double(args[7]),
          let windowWidth = Double(args[8]), windowWidth > 0 else {
        fail("用法：window-tool crop 输入 输出 x y 宽 高 窗口宽")
    }
    guard let image = NSImage(contentsOfFile: args[2]) else { fail("读不了图片：\(args[2])") }
    var proposed = NSRect(origin: .zero, size: image.size)
    guard let cg = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else { fail("解码失败") }
    let scale = Double(cg.width) / windowWidth
    let box = CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale).integral
    guard let cropped = cg.cropping(to: box) else { fail("裁剪区域超出图片范围") }
    let rep = NSBitmapImageRep(cgImage: cropped)
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("编码失败") }
    do { try png.write(to: URL(fileURLWithPath: args[3])) } catch { fail("写不了文件：\(error)") }
default:
    fail("用法：window-tool list [pid] | crop 输入 输出 x y 宽 高 窗口宽")
}
