import CoreGraphics
import Foundation
import UIKit

/**
 Draws a floor plan onto a PDF page with Apple's own PDF renderer.

 RoomPlan measures the room and exports USD; it has no 2D plan and no PDF, so nothing in
 the framework can be asked for this drawing. What it can be asked for is the geometry,
 which is already in the RSG by the time anything here runs — including the furniture the
 user added, which `CapturedRoom` never sees and never could.

 So the page is composed in TypeScript, where the scene graph lives, and inked here by
 `UIGraphicsPDFRenderer`. The split is deliberate: everything that decides WHERE a line
 goes is testable under node in the milestone gate, and everything on this side is a
 faithful, decision-free transcription of what it decided. If a wall is in the wrong
 place, the bug is not in this file.

 Sheet space is points, origin top-left, +y down — which is exactly the context
 `UIGraphicsPDFRenderer` hands to its drawing block, so no flip happens anywhere.
 */
enum BlueprintPDF {
  // MARK: - The sheet, as the TypeScript side emits it

  struct Stroke: Decodable {
    let colour: String
    let width: CGFloat
    let dash: [CGFloat]?
  }

  struct PathPrimitive: Decodable {
    let points: [[CGFloat]]
    let closed: Bool
    let stroke: Stroke?
    let fill: String?
  }

  struct TextPrimitive: Decodable {
    let at: [CGFloat]
    let text: String
    let sizePt: CGFloat
    let colour: String
    let align: String
    let baseline: String
    let rotationDeg: CGFloat
    let bold: Bool
  }

  enum Primitive {
    case path(PathPrimitive)
    case text(TextPrimitive)
  }

  struct Sheet: Decodable {
    let width: CGFloat
    let height: CGFloat
    let scaleLabel: String
    let primitives: [Primitive]

    private enum CodingKeys: String, CodingKey { case width, height, scaleLabel, primitives }
    private enum KindKey: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
      let root = try decoder.container(keyedBy: CodingKeys.self)
      width = try root.decode(CGFloat.self, forKey: .width)
      height = try root.decode(CGFloat.self, forKey: .height)
      scaleLabel = try root.decode(String.self, forKey: .scaleLabel)
      var list = try root.nestedUnkeyedContainer(forKey: .primitives)
      var decoded: [Primitive] = []
      // `kind` has to be read from a copy: reading a value out of an unkeyed container
      // advances it, and the element still has to be decoded whole afterwards.
      while !list.isAtEnd {
        var probe = list
        let kind = try probe.nestedContainer(keyedBy: KindKey.self).decode(String.self, forKey: .kind)
        switch kind {
        case "path": decoded.append(.path(try list.decode(PathPrimitive.self)))
        case "text": decoded.append(.text(try list.decode(TextPrimitive.self)))
        default:
          // A primitive this binary predates is skipped rather than fatal. The drawing
          // loses a detail; it does not lose the room.
          _ = try list.decode(AnyDecodable.self)
        }
      }
      primitives = decoded
    }
  }

  /// Consumes one element of unknown shape so an unrecognised primitive can be skipped.
  private struct AnyDecodable: Decodable {
    init(from decoder: Decoder) throws { _ = try decoder.singleValueContainer() }
  }

  // MARK: - Drawing

  enum Failure: Error, LocalizedError {
    case malformedSheet(String)

    var errorDescription: String? {
      switch self {
      case .malformedSheet(let detail): return "The blueprint could not be read: \(detail)"
      }
    }
  }

  /// `#rrggbb`. Anything else is black, which is visible and therefore reportable.
  private static func colour(_ hex: String) -> UIColor {
    var value: UInt64 = 0
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard digits.count == 6, Scanner(string: digits).scanHexInt64(&value) else { return .black }
    return UIColor(
      red: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }

  private static func font(size: CGFloat, bold: Bool) -> UIFont {
    // Helvetica is a PDF base font, so the page stays small and reads identically in
    // every viewer without embedding. The system font is only a safety net.
    UIFont(name: bold ? "Helvetica-Bold" : "Helvetica", size: size)
      ?? UIFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
  }

  private static func draw(_ primitive: PathPrimitive, into context: CGContext) {
    let points = primitive.points.compactMap { pair -> CGPoint? in
      guard pair.count >= 2 else { return nil }
      return CGPoint(x: pair[0], y: pair[1])
    }
    guard let first = points.first, points.count >= 2 else { return }

    let path = CGMutablePath()
    path.move(to: first)
    for point in points.dropFirst() { path.addLine(to: point) }
    if primitive.closed { path.closeSubpath() }

    if let fill = primitive.fill, points.count >= 3 {
      context.saveGState()
      context.addPath(path)
      context.setFillColor(colour(fill).cgColor)
      context.fillPath()
      context.restoreGState()
    }
    guard let stroke = primitive.stroke else { return }
    context.saveGState()
    context.addPath(path)
    context.setStrokeColor(colour(stroke.colour).cgColor)
    context.setLineWidth(stroke.width)
    context.setLineJoin(.round)
    context.setLineCap(.butt)
    if let dash = stroke.dash, !dash.isEmpty { context.setLineDash(phase: 0, lengths: dash) }
    context.strokePath()
    context.restoreGState()
  }

  private static func draw(_ primitive: TextPrimitive, into context: CGContext) {
    guard primitive.at.count >= 2, !primitive.text.isEmpty else { return }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font(size: primitive.sizePt, bold: primitive.bold),
      .foregroundColor: colour(primitive.colour),
    ]
    let string = NSAttributedString(string: primitive.text, attributes: attributes)
    let size = string.size()
    // `at` names a point on the run of text rather than its top-left corner, so the
    // offset is resolved here where the measured width finally exists.
    let dx: CGFloat
    switch primitive.align {
    case "centre": dx = -size.width / 2
    case "right": dx = -size.width
    default: dx = 0
    }
    let dy: CGFloat = primitive.baseline == "middle" ? -size.height / 2 : 0

    context.saveGState()
    context.translateBy(x: primitive.at[0], y: primitive.at[1])
    // +y is down here, so a positive angle turns clockwise on the page — the same
    // direction SVG's rotate() turns, which is what keeps the preview and the PDF
    // agreeing about which way a wall label reads.
    if primitive.rotationDeg != 0 { context.rotate(by: primitive.rotationDeg * .pi / 180) }
    string.draw(at: CGPoint(x: dx, y: dy))
    context.restoreGState()
  }

  // MARK: - Entry point

  /// Renders `sheetJSON` and returns the `file://` URL it was written to.
  static func render(sheetJSON: String, fileName: String, title: String) throws -> URL {
    guard let data = sheetJSON.data(using: .utf8) else {
      throw Failure.malformedSheet("the sheet was not valid UTF-8")
    }
    let sheet: Sheet
    do {
      sheet = try JSONDecoder().decode(Sheet.self, from: data)
    } catch {
      throw Failure.malformedSheet(error.localizedDescription)
    }
    guard sheet.width > 0, sheet.height > 0 else {
      throw Failure.malformedSheet("the page has no size")
    }

    let format = UIGraphicsPDFRendererFormat()
    format.documentInfo = [
      kCGPDFContextTitle as String: title,
      kCGPDFContextCreator as String: "Dex",
      kCGPDFContextSubject as String: "Floor plan at \(sheet.scaleLabel)",
    ]
    let bounds = CGRect(x: 0, y: 0, width: sheet.width, height: sheet.height)
    let renderer = UIGraphicsPDFRenderer(bounds: bounds, format: format)
    let pdf = renderer.pdfData { page in
      page.beginPage()
      let context = page.cgContext
      // PDF pages carry no background. Viewers that composite onto dark chrome would
      // otherwise show a drawing in black ink on black.
      context.setFillColor(UIColor.white.cgColor)
      context.fill(bounds)
      for primitive in sheet.primitives {
        switch primitive {
        case .path(let path): draw(path, into: context)
        case .text(let text): draw(text, into: context)
        }
      }
    }

    // Caches rather than Documents: this is a derived artefact that can always be drawn
    // again, and leaving a PDF per export in the user's document store is litter.
    let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("blueprints", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let safeName = fileName.isEmpty ? "blueprint.pdf" : fileName
    let url = directory.appendingPathComponent(safeName)
    try pdf.write(to: url, options: .atomic)
    return url
  }
}
