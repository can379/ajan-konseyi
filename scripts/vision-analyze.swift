import Foundation
import Vision
import CoreImage
import CoreGraphics
import ImageIO

struct Result: Codable {
    let file: String
    let text: [String]
    let labels: [String]
    let averageColor: String?
    let error: String?
}

func averageColor(_ url: URL) -> String? {
    guard let image = CIImage(contentsOf: url) else { return nil }
    let extent = image.extent
    guard let filter = CIFilter(name: "CIAreaAverage") else { return nil }
    filter.setValue(image, forKey: kCIInputImageKey)
    filter.setValue(CIVector(cgRect: extent), forKey: kCIInputExtentKey)
    guard let output = filter.outputImage else { return nil }
    var rgba = [UInt8](repeating: 0, count: 4)
    CIContext().render(
        output, toBitmap: &rgba, rowBytes: 4,
        bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
        format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()
    )
    return String(format: "#%02X%02X%02X", rgba[0], rgba[1], rgba[2])
}

var results: [Result] = []
for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        results.append(Result(file: url.lastPathComponent, text: [], labels: [], averageColor: nil, error: "Görsel açılamadı"))
        continue
    }
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.usesLanguageCorrection = true
    textRequest.recognitionLanguages = ["tr-TR", "en-US"]
    let classifyRequest = VNClassifyImageRequest()
    var errors: [String] = []
    do { try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([textRequest]) }
    catch { errors.append("OCR: \(error.localizedDescription)") }
    do { try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([classifyRequest]) }
    catch { errors.append("Sınıflandırma: \(error.localizedDescription)") }
    let text = (textRequest.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let labels = (classifyRequest.results ?? []).filter { $0.confidence >= 0.08 }.prefix(8)
        .map { "\($0.identifier) (%\(Int($0.confidence * 100)))" }
    results.append(Result(file: url.lastPathComponent, text: text, labels: labels, averageColor: averageColor(url), error: errors.isEmpty ? nil : errors.joined(separator: "; ")))
}
let data = try JSONEncoder().encode(results)
FileHandle.standardOutput.write(data)
