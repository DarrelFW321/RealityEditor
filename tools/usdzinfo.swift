import Foundation
import RealityKit

// Loads a USDZ with RealityKit — the SAME loader the phone uses — and prints what
// it saw, as one JSON object. Helper for tools/make_catalog_usdz.py.
//
// WHY REALITYKIT AND NOT A USD LIBRARY: the question is never "is this valid
// USD", it is "what will SceneRenderer.loadCatalogAsset actually draw". Bounds
// as RealityKit measures them are what `dims_m` in the manifest has to match;
// triangles as RealityKit counts them are what `poly_count` promises; and a
// material that RealityKit dropped is the difference between a walnut desk and
// a white one. A USD checker can pass a file RealityKit renders blank.
//
// FACING. SceneRenderer's convention: at yaw 0 an object faces -Z, so its BACK
// is +Z (see `SceneRenderer.chair`). `back_mass_z` is the mean Z of every
// vertex in the top 40% of the model — for a chair, sofa or bed that is the
// backrest or headboard, so a positive number means it faces the right way and
// a negative one means the packager has to spin it 180°.
//
// Output: {"extents":[w,h,d], "triangles":N, "materials":N, "models":N,
//          "back_mass_z": Z}
guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: usdzinfo <file.usdz>\n".data(using: .utf8)!)
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])

let root: Entity
do {
    root = try Entity.load(contentsOf: url)
} catch {
    FileHandle.standardError.write("load failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

func models(in entity: Entity) -> [ModelEntity] {
    var found: [ModelEntity] = []
    if let model = entity as? ModelEntity { found.append(model) }
    for child in entity.children { found.append(contentsOf: models(in: child)) }
    return found
}

let bounds = root.visualBounds(relativeTo: nil)
let extents = bounds.extents
let parts = models(in: root)

var triangles = 0
var materials = 0
var sumZ = 0.0
var count = 0
let upperCut = bounds.min.y + 0.6 * (bounds.max.y - bounds.min.y)

for model in parts {
    materials += model.model?.materials.count ?? 0
    guard let mesh = model.model?.mesh else { continue }
    let matrix = model.transformMatrix(relativeTo: nil)
    for meshModel in mesh.contents.models {
        for part in meshModel.parts {
            triangles += (part.triangleIndices?.count ?? 0) / 3
            for position in part.positions.elements {
                let world = matrix * SIMD4<Float>(position, 1)
                if world.y > upperCut {
                    sumZ += Double(world.z)
                    count += 1
                }
            }
        }
    }
}

let backMassZ = count > 0 ? sumZ / Double(count) : 0
print(String(format: "{\"extents\":[%.4f,%.4f,%.4f],\"triangles\":%d,\"materials\":%d,\"models\":%d,\"back_mass_z\":%.4f}",
             extents.x, extents.y, extents.z, triangles, materials, parts.count, backMassZ))
