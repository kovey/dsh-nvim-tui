import Foundation
import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("无法加载图片"); exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([req])
    let obs = req.results ?? []
    print("识别到 \(obs.count) 段文本：")
    for o in obs {
        if let t = o.topCandidates(1).first { print(t.string) }
    }
} catch { print("OCR 失败: \(error)") }
