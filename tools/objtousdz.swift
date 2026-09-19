import Foundation
import ModelIO

// OBJ -> USDA, via ModelIO. Helper for tools/make_catalog_usdz.py, which does
// the fix-ups this cannot and packages the result as USDZ.
//
// WHY NOT STRAIGHT TO USDZ: `MDLAsset.canExportFileExtension("usdz")` is FALSE
// on macOS — ModelIO writes usda/usdc only, and /usr/bin/usdzip does the
// packaging. Exporting text (usda) rather than binary (usdc) is deliberate:
// the Python side has to rewrite two things in it before it is valid USD.
//
// Prints the model's own bounding box so the caller can sanity-check the
// manifest's `dims_m` against the geometry actually being shipped.
guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write("usage: objtousdz <in.obj> <out.usda>\n".data(using: .utf8)!)
    exit(2)
}
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])

guard MDLAsset.canExportFileExtension(output.pathExtension) else {
    FileHandle.standardError.write("cannot export .\(output.pathExtension) here\n".data(using: .utf8)!)
    exit(1)
}

let asset = MDLAsset(url: input)
asset.loadTextures()
do {
    try asset.export(to: output)
    let box = asset.boundingBox(atTime: 0)
    print(String(format: "%.3f %.3f %.3f",
                 box.maxBounds.x - box.minBounds.x,
                 box.maxBounds.y - box.minBounds.y,
                 box.maxBounds.z - box.minBounds.z))
} catch {
    FileHandle.standardError.write("export failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
