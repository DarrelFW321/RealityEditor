import ExpoModulesCore
import ARKit
import RoomPlan
import SceneKit
import Vision
import UIKit

public class SpatialCaptureModule: Module {
  // Ownership outlives the native view, so late releases after exit/recalibration
  // cannot accidentally target the replacement view's pool.
  fileprivate let frameTextures = SpatialFrameTextures()
  fileprivate weak var activeView: SpatialCaptureView?
  public func definition() -> ModuleDefinition {
    Name("SpatialCapture")
    Function("isSupported") { RoomCaptureSession.isSupported }
    AsyncFunction("acquireTextureFrame") {
      (contextId: Int, frameId: String, width: Double, height: Double, promise: Promise) in
      guard let view = self.activeView else { promise.resolve(nil); return }
      view.acquireTextureFrame(contextId: contextId, expectedFrameId: frameId,
                               width: width, height: height, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("releaseTextureFrame") { (leaseId: String) in
      self.frameTextures.release(lease: leaseId)
    }.runOnQueue(.main)
    AsyncFunction("captureFrame") { (promise: Promise) in
      guard let view = self.activeView else { promise.resolve(nil); return }
      view.captureFrame(promise: promise)
    }
    AsyncFunction("invalidateTextureFrames") {
      self.activeView?.invalidateTextureFrames()
    }.runOnQueue(.main)
    /**
     Inks a floor plan onto a PDF page and returns its `file://` URL.

     Deliberately takes a finished sheet rather than the room: RoomPlan has no floor-plan
     export to call, and the drawing has to include furniture that only exists in the
     editor's scene graph, so the page is laid out in TypeScript where that graph lives.
     This side is Core Graphics and nothing else, which is why it needs no RoomPlan state
     and works just as well on the development room.

     Off the main queue on purpose. A page takes tens of milliseconds to draw and the AR
     session is on the other side of that stall.
     */
    AsyncFunction("blueprintPDF") { (sheetJSON: String, fileName: String, title: String) -> String in
      try BlueprintPDF.render(sheetJSON: sheetJSON, fileName: fileName, title: title).absoluteString
    }
    OnDestroy {
      let textures = self.frameTextures
      DispatchQueue.main.async { textures.dispose() }
    }
    View(SpatialCaptureView.self) {
      Events("onRoom", "onFrame", "onStatus", "onKeyframe")
      Prop("mode") { (view: SpatialCaptureView, mode: String) in view.setMode(mode) }
      Prop("roomOrigin") { (view: SpatialCaptureView, origin: [Double]?) in
        view.setRoomAnchor(origin)
      }
    }
  }
}

// SceneKit is used only for the native camera background. Editable content is
// rendered by R3F. One ARSession survives measurement -> editing.
final class SpatialCaptureView: ExpoView, RoomCaptureSessionDelegate, ARSCNViewDelegate {
  private weak var textureModule: SpatialCaptureModule?
  private var textureGeneration = 0
  private var textureSequence = 0
  private var compositingInputsRequested = false
  private var backgroundObserver: NSObjectProtocol?
  let onRoom = EventDispatcher()
  let onFrame = EventDispatcher()
  let onStatus = EventDispatcher()
  /// Registered visual references, captured DURING the measurement sweep.
  ///
  /// Replaces a separate Vision Camera pass that turned the user through another
  /// 300° and produced files nothing consumed — `captures.current` was read only
  /// to render a count, and mobile/README.md says so outright: "their
  /// registration into the measured frame is not implemented, so they are not
  /// uploaded or falsely labeled as tracked keyframes".
  ///
  /// Taken from the retained ARSession, each keyframe carries the pose and
  /// intrinsics of the frame it came from, so it is registered to the measured
  /// room by construction rather than by a later solve.
  let onKeyframe = EventDispatcher()
  private let arSession = ARSession()
  private let cameraView = ARSCNView(frame: .zero)
  private var capture: RoomCaptureSession?
  /// ANCHORS THE ROOM TO THE WORLD SO IT STOPS DRIFTING.
  ///
  /// Room geometry used to be frozen against the ARKit world origin as it stood the
  /// instant the scan finished. ARKit keeps refining that estimate - relocalisation and
  /// loop closure move the world frame - and nothing told the room about it, so placed
  /// objects slid away from the real surfaces they were placed on.
  ///
  /// ARKit adjusts anchor transforms when it revises its understanding of the space. By
  /// pinning the room's origin to an anchor and reading that anchor's CURRENT transform
  /// every frame, the correction is applied for free and the room stays put.
  private var roomAnchor: ARAnchor?

  /**
   Every scan of this room so far, in one world frame.

   RoomPlan cannot see past roughly five metres, so a large room from one standing position
   is a partial room no matter how patiently it is swept. Scanning again from somewhere else
   and MERGING is the supported answer: `StructureBuilder` takes several `CapturedRoom`s and
   returns one `CapturedStructure` with the duplicate walls reconciled.

   The merge is only meaningful because every pass shares an ARSession, and therefore a
   world origin. `RoomCaptureSession(arSession:)` is handed the existing session and nothing
   here ever calls `resetTracking`, so pass two is already in pass one's coordinates and no
   relocalization step is needed. Starting a fresh `ARSession` per pass would put each room
   in its own origin and merge them into nonsense.
   */
  private var capturedRooms: [CapturedRoom] = []
  private var mode = "idle"
  /**
   What JS last asked for, which is not always what `mode` became.

   `rescan` runs as `mode == "scan"` because every delegate, counter and finish path treats
   the two identically. Guarding the entry point on `mode` would therefore compare a later
   `scan` against the `scan` a `rescan` left behind, decide nothing had changed, and
   silently refuse to start the fresh room the user asked for.
   */
  private var requestedMode = "idle"
  private var lastFrame: TimeInterval = 0
  private let handQueue = DispatchQueue(label: "reality.hand", qos: .userInitiated)
  private var processing = false
  private lazy var handRequest: VNDetectHumanHandPoseRequest = {
    let request = VNDetectHumanHandPoseRequest()
    request.maximumHandCount = 1
    return request
  }()
  private var lastHandSample: TimeInterval = -.infinity
  private var handProcessed = 0
  private var handDropped = 0
  private var handActive = false
  private var handStreak = 0
  private var lastGoodHandTime: TimeInterval?
  private var filteredHand: CGPoint?
  private var lastFilterTime: TimeInterval?
  private var pinching = false
  private var pinchStreak = 0
  private var generation = 0
  private var frameId = UUID().uuidString
  private var frameSequence = 0
  private var interfaceOrientation: UIInterfaceOrientation = .portrait
  private var viewportSize: CGSize = .zero
  private var previousFrameTime: TimeInterval = 0
  private var memoryWarnings = 0
  private var memoryObserver: NSObjectProtocol?
  private var scanWalls = 0
  private var scanFloors = 0
  private var scanYaw: Float?
  private var scanDirection: Float = 0
  /// Signed rotation seen before the sweep direction is committed.
  ///
  /// `scanDirection` used to latch on the FIRST frame whose delta exceeded
  /// 0.001 rad — 0.057°, which is hand tremor, not intent. Latching the wrong
  /// way made every subsequent real rotation negative, and `max(0, …)` below
  /// clamped the total to zero permanently: the sweep read 0° however far the
  /// user turned, and only `resetScanProgress()` could clear it. It was a coin
  /// flip per run.
  private var scanDirectionEvidence: Float = 0
  /// ~7° of consistent rotation before committing. Far above tremor, far below
  /// the 45° keyframe spacing.
  private static let directionLatchRadians: Float = 0.12
  /// ~690 deg/s. Above this a yaw change is a tracking jump, not a turn.
  private static let maxTurnRateRadians: Float = 12
  /// Sample time paired with `scanYaw`, so the delta can be read as a rate.
  private var scanYawTime: TimeInterval?
  private var scanDegrees: Float = 0
  private var reportedScanBucket = -1

  /// Six references across the 270° the sweep already requires, so the last one
  /// lands at 225° and none depends on the user over-rotating.
  private static let keyframeCount = 6
  private static let keyframeSpacingDegrees: Float = 270 / Float(keyframeCount)
  /// Its own queue and single-inflight flag, matching `handQueue`/`processing`.
  /// JPEG encoding is far heavier than a Vision request, so it must never be
  /// allowed to queue behind itself.
  private let keyframeQueue = DispatchQueue(label: "reality.keyframe", qos: .utility)
  private var keyframeEncoding = false
  private var keyframesEmitted = 0
  private var highResolutionCapture = false
  private lazy var keyframeContext = CIContext(options: [.useSoftwareRenderer: false])

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    cameraView.session = arSession
    cameraView.delegate = self
    cameraView.scene = SCNScene()
    addSubview(cameraView)
    textureModule = appContext?.moduleRegistry.get(moduleWithName: "SpatialCapture") as? SpatialCaptureModule
    textureModule?.activeView = self
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.invalidateTextureFrames() }
    memoryObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.memoryWarnings += 1
      self?.onStatus(["code": "memory_warning", "message": "iOS reported memory pressure."])
    }
  }
  deinit {
    if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    cameraView.frame = bounds
    viewportSize = bounds.size
    interfaceOrientation = window?.windowScene?.interfaceOrientation ?? .portrait
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { stop() }
  }
  private func stop() {
    requestedMode = "idle"
    // Leaving the room behind means leaving its passes behind: a later scan is a new room,
    // not another view of this one.
    capturedRooms.removeAll()
    invalidateTextureFrames()
    compositingInputsRequested = false
    generation += 1
    capture?.stop(pauseARSession: true)
    capture?.delegate = nil
    capture = nil
    arSession.pause()
    mode = "idle"
    processing = false
    setRoomAnchor(nil)
    resetHandTracking()
    onStatus(["code": "camera_owner", "message": "Spatial camera released."])
  }
  /// `origin` is the room origin in world coordinates, as the conversion computed it.
  /// Passing nil removes the anchor, which returns the room to a fixed world pose.
  func setRoomAnchor(_ origin: [Double]?) {
    invalidateTextureFrames()
    if let existing = roomAnchor {
      arSession.remove(anchor: existing)
      roomAnchor = nil
    }
    guard let origin, origin.count == 3, origin.allSatisfy({ $0.isFinite }) else { return }
    var transform = matrix_identity_float4x4
    transform.columns.3 = SIMD4<Float>(Float(origin[0]), Float(origin[1]), Float(origin[2]), 1)
    let anchor = ARAnchor(name: "room-origin", transform: transform)
    roomAnchor = anchor
    arSession.add(anchor: anchor)
  }

  /// The anchor's transform as ARKit currently believes it, not as it was created.
  /// Nil until an anchor exists, which is what the JavaScript fallback keys off.
  private func roomAnchorTransform(_ frame: ARFrame) -> [Float]? {
    guard let roomAnchor else { return nil }
    guard let live = frame.anchors.first(where: { $0.identifier == roomAnchor.identifier })
    else { return nil }
    return array(live.transform)
  }

  func setMode(_ next: String) {
    guard next != requestedMode else { return }
    requestedMode = next
    if next == "idle" { stop(); return }
    guard RoomCaptureSession.isSupported else {
      onStatus(["code": "unsupported", "message": "Room measurement requires a supported LiDAR iPhone."])
      return
    }
    // `scan` starts a room; `rescan` adds a pass to the one being built. The only
    // difference is whether the accumulated rooms survive, which is why they share
    // everything below it.
    if next == "scan" || next == "rescan" {
      if next == "scan" { capturedRooms.removeAll() }
      invalidateTextureFrames()
      compositingInputsRequested = false
      generation += 1
      frameId = UUID().uuidString
      frameSequence = 0
      previousFrameTime = 0
      resetHandTracking()
      resetScanProgress()
      capture = RoomCaptureSession(arSession: arSession)
      capture?.delegate = self
      // Both passes run as "scan" from here on: the delegate, the progress counters and
      // the finish path do not care which pass this is.
      mode = "scan"
      onStatus([
        "code": "camera_transition",
        "message": capturedRooms.isEmpty
          ? "RoomPlan is requesting the rear camera."
          : "Scanning again to extend the room. Walk to the part that was out of range.",
        "pass": capturedRooms.count + 1,
      ])
      capture?.run(configuration: RoomCaptureSession.Configuration())
    } else if next == "edit" {
      if mode == "processing" { return }
      finishRoomCapture(message: "Finishing the room and retaining its AR session for editing.")
    }
  }
  func captureSession(_ session: RoomCaptureSession, didStartWith configuration: RoomCaptureSession.Configuration) {
    // ROOMPLAN OWNS THE ARCONFIGURATION. `run(configuration:)` takes a
    // RoomCaptureSession.Configuration — which carries only `isCoachingEnabled`
    // — and RoomPlan runs the ARSession with a format of its own choosing. So
    // the high-resolution video format cannot be requested; it can only be
    // detected after the fact.
    //
    // `captureHighResolutionFrame` is safe to call on any format, but the
    // header is explicit that some formats "do not support a significantly
    // higher still image resolution than the streaming camera resolution".
    // Reported in the status so the device gate can record which path ran
    // rather than inferring it from image dimensions.
    let recommended = session.arSession.configuration?.videoFormat
      .isRecommendedForHighResolutionFrameCapturing ?? false
    DispatchQueue.main.async {
      guard self.mode == "scan" else { return }
      self.highResolutionCapture = recommended
      self.onStatus([
        "code": "camera_owner",
        "message": recommended
          ? "RoomPlan acquired the rear camera. References will be full-resolution stills."
          : "RoomPlan acquired the rear camera. References will come from the video stream.",
        "highResolutionReferences": recommended,
      ])
    }
  }
  func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
    let message: String
    switch instruction {
    case .normal: message = "Move slowly around the perimeter. Include every floor and ceiling edge."
    case .moveCloseToWall: message = "Move closer to the wall while keeping its corners in view."
    case .moveAwayFromWall: message = "Step back so the full wall and its edges are visible."
    case .turnOnLight: message = "The room is too dark. Turn on more lights before continuing."
    case .slowDown: message = "Move more slowly so tracking can keep up."
    case .lowTexture: message = "Aim at a corner, doorway, or textured edge so tracking has a visual feature."
    @unknown default: message = "Move slowly and keep room boundaries in view."
    }
    DispatchQueue.main.async { self.onStatus(["code": "guidance", "message": message]) }
  }
  func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
    let walls = room.walls.count
    let floors = room.floors.count
    let openings = room.doors.count + room.openings.count
    scanWalls = walls
    scanFloors = floors
    DispatchQueue.main.async {
      if self.scanDegrees >= 270, walls >= 3 {
        self.finishRoomCapture(message: "Room coverage complete. Building the room…")
        return
      }
      let message = self.scanDegrees >= 270
        ? "Rotation complete. Aim toward one more room boundary."
        : "Observed \(walls) walls, \(floors) floor, and \(openings) openings. Keep turning steadily."
      self.onStatus(["code": "observing",
        "message": message,
        "wallCount": walls, "floorCount": floors, "openingCount": openings])
    }
  }
  func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
    guard mode == "processing" else { return }
    let epoch = generation
    if let error {
      mode = "failed"
      onStatus(["code": "failed", "message": "Room capture failed: \(error.localizedDescription)"])
      return
    }
    Task {
      do {
        let room = try await RoomBuilder(options: []).capturedRoom(from: data)
        await MainActor.run { self.capturedRooms.append(room) }
        let rooms = await MainActor.run { self.capturedRooms }

        /*
         ONE PASS IS A ROOM; SEVERAL ARE A STRUCTURE.

         `StructureBuilder` is what reconciles them — the same wall seen from two positions
         becomes one wall rather than two near-duplicates a metre apart, which is exactly
         what naively concatenating the surfaces would produce. It is skipped for a single
         pass because merging one room is pure cost: it is the slower of the two builders
         and has nothing to reconcile.

         `.beautifyObjects` is what makes a second pass worth taking. It squares up and
         de-duplicates the merged result, so extra coverage improves the room instead of
         just adding more approximate surfaces to it.
         */
        let merged: (walls: [CapturedRoom.Surface], floors: [CapturedRoom.Surface],
                     doors: [CapturedRoom.Surface], windows: [CapturedRoom.Surface],
                     openings: [CapturedRoom.Surface], objects: [CapturedRoom.Object], id: UUID)
        if rooms.count > 1 {
          let structure = try await StructureBuilder(options: [.beautifyObjects])
            .capturedStructure(from: rooms)
          merged = (structure.walls, structure.floors, structure.doors, structure.windows,
                    structure.openings, structure.objects, structure.identifier)
        } else {
          merged = (room.walls, room.floors, room.doors, room.windows,
                    room.openings, room.objects, room.identifier)
        }

        let surfaces = merged.walls.map { surface($0, kind: "wall") }
          + merged.floors.map { surface($0, kind: "floor") }
          + merged.doors.map { surface($0, kind: "door") }
          + merged.windows.map { surface($0, kind: "window") }
          + merged.openings.map { surface($0, kind: "opening") }
        let objects: [[String: Any]] = merged.objects.map { object in
          ["id": object.identifier.uuidString, "category": String(describing: object.category),
           "transform": array(object.transform), "dimensions": [object.dimensions.x, object.dimensions.y, object.dimensions.z]]
        }
        let encoded = try JSONSerialization.data(withJSONObject: ["id": merged.id.uuidString, "surfaces": surfaces, "objects": objects])
        let json = String(data: encoded, encoding: .utf8) ?? "{}"
        await MainActor.run {
          // A superseded scan's result is dropped, but NOT silently: this used to
          // return with `mode` left on "processing", so the view stayed on
          // "Building the room…" for the rest of the session with no way back.
          guard self.generation == epoch else {
            if self.mode == "processing" {
              self.mode = "failed"
              self.onStatus(["code": "failed",
                "message": "That scan was superseded before it finished building. Start a new scan."])
            }
            return
          }
          self.mode = "edit"
          self.onStatus([
            "code": "camera_owner",
            "message": rooms.count > 1
              ? "Merged \(rooms.count) scans into one room. Tracked editing retained the AR session."
              : "Tracked editing retained the RoomPlan AR session.",
            "passes": rooms.count,
          ])
          self.onRoom(["roomJSON": json, "frameId": self.frameId, "passes": rooms.count])
        }
      } catch {
        await MainActor.run {
          self.mode = "failed"
          self.onStatus(["code": "failed", "message": "Room processing failed: \(error.localizedDescription)"])
        }
      }
    }
  }
  func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
    // ARSCNView owns frame scheduling, avoiding replacement of RoomPlan's ARSession delegate.
    guard time - lastFrame > 1.0 / 20.0, let frame = arSession.currentFrame else { return }
    lastFrame = time
    let camera = frame.camera
    let tracking: String
    let trackingReason: String
    switch camera.trackingState {
    case .normal:
      tracking = "normal"
      trackingReason = "none"
    case .notAvailable:
      tracking = "lost"
      trackingReason = "not_available"
    case .limited(let reason):
      tracking = "limited"
      trackingReason = String(describing: reason)
    }
    frameSequence += 1
    let sequence = frameSequence
    let fps = previousFrameTime > 0 ? 1.0 / max(frame.timestamp - previousFrameTime, 0.0001) : 0
    previousFrameTime = frame.timestamp
    let epoch = generation
    let orientation = interfaceOrientation
    let size = viewportSize
    let frameTimestamp = frame.timestamp
    let worldMapping = worldMappingName(frame.worldMappingStatus)
    let thermalState = thermalStateName(ProcessInfo.processInfo.thermalState)
    let warningCount = memoryWarnings
    DispatchQueue.main.async {
      guard self.mode != "idle", self.generation == epoch, size.width > 0 else { return }
      if self.mode == "scan" {
        self.updateScanProgress(camera.transform, at: time)
        self.captureKeyframeIfDue(frame: frame, orientation: orientation, epoch: epoch)
      }
      let view = camera.viewMatrix(for: orientation)
      let projection = camera.projectionMatrix(for: orientation, viewportSize: size, zNear: 0.01, zFar: 100)
      var payload: [String: Any] = ["timestamp": frame.timestamp * 1000, "frameId": self.frameId, "tracking": tracking,
        "trackingReason": trackingReason, "sequence": sequence, "fps": fps,
        "viewportWidth": size.width, "viewportHeight": size.height,
        "orientation": self.orientationName(orientation),
        "worldMapping": worldMapping,
        "thermalState": thermalState,
        "memoryWarnings": warningCount,
        "cameraToWorld": self.array(view.inverse), "projection": self.array(projection)]
      // Read every frame, not once at creation: the whole point is that ARKit moves it.
      if let anchored = self.roomAnchorTransform(frame) { payload["roomAnchor"] = anchored }
      self.onFrame(payload)
      if self.mode == "edit" && frameTimestamp - self.lastHandSample >= 1.0 / 12.0 {
        if self.processing {
          self.handDropped += 1
          return
        }
        self.lastHandSample = frameTimestamp
        self.processing = true
        let pixelBuffer = frame.capturedImage
        let visionOrientation = self.visionOrientation(orientation)
        let displayTransform = frame.displayTransform(for: orientation, viewportSize: size)
        self.handQueue.async {
          var detection: HandDetection?
          do {
            try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: visionOrientation)
              .perform([self.handRequest])
            if let hand = self.handRequest.results?.first,
               let tip = try? hand.recognizedPoint(.indexTip) {
              let oriented = CGPoint(x: tip.location.x, y: 1 - tip.location.y)
              let raw = self.rawImagePoint(oriented, orientation: visionOrientation)
              let display = raw.applying(displayTransform)
              let confidence = Double(min(hand.confidence, tip.confidence))
              var ratio: Double?
              if let thumb = try? hand.recognizedPoint(.thumbTip),
                 let wrist = try? hand.recognizedPoint(.wrist),
                 let middle = try? hand.recognizedPoint(.middleMCP),
                 min(thumb.confidence, wrist.confidence, middle.confidence) >= 0.3 {
                let palm = hypot(wrist.location.x - middle.location.x,
                                 wrist.location.y - middle.location.y)
                if palm > 0.0001 {
                  ratio = Double(hypot(thumb.location.x - tip.location.x,
                                       thumb.location.y - tip.location.y) / palm)
                }
              }
              detection = HandDetection(point: display, rawPoint: raw,
                                        confidence: confidence, pinchRatio: ratio)
            }
          } catch {
            DispatchQueue.main.async {
              self.onStatus(["code": "hand_error", "message": "Hand tracking failed: \(error.localizedDescription)"])
            }
          }
          DispatchQueue.main.async {
            self.processing = false
            guard self.generation == epoch else { return }
            self.handProcessed += 1
            var cursor = self.acceptHand(detection, timestamp: frameTimestamp)
            cursor["latencyMs"] = max(0, (ProcessInfo.processInfo.systemUptime - frameTimestamp) * 1000)
            var handPayload = payload
            handPayload["timestamp"] = frameTimestamp * 1000
            handPayload["hand"] = cursor
            self.onFrame(handPayload)
          }
        }
      }
    }
  }
  // M8-A feasibility path, opt-in from the development panel. It samples the
  // existing ARSession directly; the 20 Hz metadata/hand pump is not its clock.
  func acquireTextureFrame(contextId: Int, expectedFrameId: String,
                           width: Double, height: Double, promise: Promise) {
    guard mode == "edit", UIApplication.shared.applicationState == .active,
          expectedFrameId == frameId, contextId > 0,
          width.isFinite, height.isFinite, width > 0, height > 0,
          width <= 8192, height <= 8192,
          let frame = arSession.currentFrame,
          ProcessInfo.processInfo.systemUptime - frame.timestamp < 0.15,
          case .normal = frame.camera.trackingState else { promise.resolve(nil); return }
    if !compositingInputsRequested {
      compositingInputsRequested = true
      enableCompositingInputs()
    }
    textureSequence += 1
    let size = CGSize(width: width, height: height)
    let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
    let inverseDisplay = frame.displayTransform(for: orientation, viewportSize: size).inverted()
    var metadata: [String: Any] = [
      "version": 1, "frameId": frameId, "generation": textureGeneration,
      "sequence": textureSequence, "timestamp": frame.timestamp * 1000,
      "viewportWidth": width, "viewportHeight": height,
      "cameraToWorld": array(frame.camera.viewMatrix(for: orientation).inverse),
      "projection": array(frame.camera.projectionMatrix(for: orientation, viewportSize: size,
                                                         zNear: 0.01, zFar: 100)),
      // Column-major; normalized top-left display UV -> raw sensor UV.
      "displayToImage": [inverseDisplay.a, inverseDisplay.b, 0,
                         inverseDisplay.c, inverseDisplay.d, 0,
                         inverseDisplay.tx, inverseDisplay.ty, 1],
    ]
    guard let anchor = roomAnchorTransform(frame) else { promise.resolve(nil); return }
    metadata["roomAnchor"] = anchor
    guard let textures = textureModule?.frameTextures else { promise.resolve(nil); return }
    textures.acquire(frame: frame, contextId: NSNumber(value: contextId), metadata: metadata) {
      result in promise.resolve(result)
    }
  }
  func invalidateTextureFrames() {
    textureGeneration += 1
    textureModule?.frameTextures.invalidate()
  }
  private func enableCompositingInputs() {
    guard let configuration = arSession.configuration?.copy() as? ARWorldTrackingConfiguration else {
      onStatus(["code": "compositing_unavailable", "message": "Tracked configuration unavailable."])
      return
    }
    let requested: ARConfiguration.FrameSemantics = [.sceneDepth, .personSegmentationWithDepth]
    guard ARWorldTrackingConfiguration.supportsFrameSemantics(requested) else {
      onStatus(["code": "compositing_unavailable", "message": "Paired depth and person segmentation unavailable."])
      return
    }
    configuration.frameSemantics.formUnion(requested)
    // No resetTracking/removeExistingAnchors: calibration frame and room anchor survive.
    arSession.run(configuration, options: [])
    onStatus(["code": "compositing_inputs", "message": "Depth/foreground inputs enabled; live erasure awaits the M8 device gate."])
  }
  private func surface(_ surface: CapturedRoom.Surface, kind: String) -> [String: Any] {
    var corners = surface.polygonCorners
    if corners.isEmpty {
      let w = surface.dimensions.x / 2, h = surface.dimensions.y / 2
      // RoomPlan surface-local geometry is always in the XY plane. The
      // surface transform rotates a floor into the horizontal world plane.
      corners = [SIMD3(-w,-h,0), SIMD3(w,-h,0), SIMD3(w,h,0), SIMD3(-w,h,0)]
    }
    let polygon = corners.map { corner -> [Float] in
      let world = surface.transform * SIMD4(corner.x, corner.y, corner.z, 1)
      return [world.x, world.y, world.z]
    }
    return ["id": surface.identifier.uuidString, "kind": kind, "polygon": polygon,
      "transform": array(surface.transform), "confidence": String(describing: surface.confidence)]
  }
  private func array(_ m: simd_float4x4) -> [Float] {
    (0..<4).flatMap { c in (0..<4).map { r in m[c][r] } }
  }
  private func orientationName(_ orientation: UIInterfaceOrientation) -> String {
    switch orientation {
    case .portrait: return "portrait"
    case .portraitUpsideDown: return "portrait_upside_down"
    case .landscapeLeft: return "landscape_left"
    case .landscapeRight: return "landscape_right"
    default: return "unknown"
    }
  }

  private func worldMappingName(_ status: ARFrame.WorldMappingStatus) -> String {
    switch status {
    case .notAvailable: return "not_available"
    case .limited: return "limited"
    case .extending: return "extending"
    case .mapped: return "mapped"
    @unknown default: return "unknown"
    }
  }

  private func resetScanProgress() {
    scanWalls = 0
    scanFloors = 0
    scanYaw = nil
    scanDirection = 0
    scanDirectionEvidence = 0
    scanYawTime = nil
    scanDegrees = 0
    reportedScanBucket = -1
    keyframesEmitted = 0
    keyframeEncoding = false
  }

  /// Emits one registered keyframe each time the sweep passes a 45° threshold.
  ///
  /// Called from the main-thread block of the frame pump, so `scanDegrees` is
  /// already current for this frame.
  ///
  /// The heavy work is moved off the main thread, but — unlike the hand path
  /// above — the pixel buffer is NOT handed across threads. ARKit recycles
  /// `capturedImage` from a small pool; a Vision request returns fast enough to
  /// get away with it, a JPEG encode does not. `CIImage` is created here on the
  /// main thread while the buffer is still guaranteed live, and only the
  /// immutable image crosses the queue boundary.
  private func captureKeyframeIfDue(frame: ARFrame, orientation: UIInterfaceOrientation, epoch: Int) {
    guard keyframesEmitted < Self.keyframeCount, !keyframeEncoding else { return }
    // Threshold for the NEXT one: 0°, 45°, 90° ... 225°.
    guard scanDegrees >= Float(keyframesEmitted) * Self.keyframeSpacingDegrees else { return }

    keyframeEncoding = true
    let index = keyframesEmitted
    keyframesEmitted += 1

    // A full-resolution still if the session can give one, otherwise the
    // streaming frame. Both carry the same pose and intrinsics, so both are
    // registered; only sharpness differs.
    if highResolutionCapture {
      arSession.captureHighResolutionFrame { [weak self] captured, _ in
        guard let self else { return }
        // Falling back to `frame` rather than failing: a missed still would
        // leave a permanent gap in the sweep, and the streaming frame is a
        // usable reference.
        self.encodeKeyframe(captured ?? frame, orientation: orientation, epoch: epoch, index: index)
      }
    } else {
      encodeKeyframe(frame, orientation: orientation, epoch: epoch, index: index)
    }
  }

  /**
   One photograph of the room right now, with the pose and projection that took it.

   Distinct from the keyframe sweep, which only runs while RoomPlan is measuring and
   emits on a fixed 45-degree cadence. Live erasure needs a frame at the moment the
   user asks, from wherever they happen to be standing.

   PNG, not JPEG: this is sent to an image model and comes back as a replacement, and
   JPEG ringing around a high-contrast edge is exactly the kind of artefact that
   survives into the patch. `projection` travels alongside `cameraToWorld` because the
   caller has to project the masked box into this image and cannot reconstruct the
   frustum from intrinsics alone once the display transform is involved.
   */
  func captureFrame(promise: Promise) {
    guard mode == "edit", UIApplication.shared.applicationState == .active,
          let frame = arSession.currentFrame,
          case .normal = frame.camera.trackingState else { promise.resolve(nil); return }
    let camera = frame.camera
    let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
    let resolution = camera.imageResolution
    let size = bounds.size.width > 0 ? bounds.size : CGSize(width: resolution.width, height: resolution.height)
    let cameraToWorld = array(camera.viewMatrix(for: orientation).inverse)
    let projection = array(camera.projectionMatrix(for: orientation, viewportSize: size,
                                                   zNear: 0.01, zFar: 100))
    let currentFrameId = frameId
    let epoch = generation
    // EVERY VALUE READ OUT BEFORE THE CLOSURES, as `encodeKeyframe` below also does.
    // Referring to `frame` inside them retains the ARFrame across two thread hops, and
    // ARKit stops delivering frames while one is held — the session stalls rather than
    // erroring, which presents as the camera freezing or the app dying.
    let timestamp = frame.timestamp * 1000
    let intrinsics = array(camera.intrinsics)
    let image = CIImage(cvPixelBuffer: frame.capturedImage)

    keyframeQueue.async { [weak self] in
      guard let self else { promise.resolve(nil); return }
      let data = self.keyframeContext.pngRepresentation(
        of: image, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
      DispatchQueue.main.async { [weak self] in
        guard let self else { promise.resolve(nil); return }
        // A recalibration during the encode invalidates the pose this carries.
        guard self.generation == epoch, let data else { promise.resolve(nil); return }
        promise.resolve([
          "pngBase64": data.base64EncodedString(),
          "width": Int(resolution.width),
          "height": Int(resolution.height),
          "frameId": currentFrameId,
          "generation": epoch,
          "timestamp": timestamp,
          "cameraToWorld": cameraToWorld,
          "projection": projection,
          "intrinsics": intrinsics,
        ])
      }
    }
  }

  private func encodeKeyframe(_ frame: ARFrame, orientation: UIInterfaceOrientation,
                              epoch: Int, index: Int) {
    let camera = frame.camera
    let resolution = camera.imageResolution
    let intrinsics = camera.intrinsics
    let cameraToWorld = array(camera.viewMatrix(for: orientation).inverse)
    let identifier = UUID().uuidString
    let timestamp = frame.timestamp * 1000
    let currentFrameId = frameId
    // Created here, while ARKit still owns a live buffer.
    let image = CIImage(cvPixelBuffer: frame.capturedImage)

    keyframeQueue.async { [weak self] in
      guard let self else { return }
      let data = self.keyframeContext.jpegRepresentation(
        of: image,
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8])

      DispatchQueue.main.async {
        self.keyframeEncoding = false
        // The sweep may have been restarted or torn down mid-encode.
        guard self.generation == epoch, let data else {
          if self.generation == epoch { self.keyframesEmitted = index }
          return
        }
        // `KeyframeSchema` is `.strict()`: these keys and no others. The server
        // additionally rejects whitespace and base64url, so the default
        // `base64EncodedString()` alphabet is what it wants.
        self.onKeyframe([
          "id": identifier,
          "timestamp": timestamp,
          "width": Int(resolution.width),
          "height": Int(resolution.height),
          "frameId": currentFrameId,
          "cameraToWorld": cameraToWorld,
          "intrinsics": self.array(intrinsics),
          "jpegBase64": data.base64EncodedString(),
        ])
      }
    }
  }

  /// Column-major, matching `array(_ m: simd_float4x4)` and Three.js.
  private func array(_ m: simd_float3x3) -> [Float] {
    (0..<3).flatMap { c in (0..<3).map { r in m[c][r] } }
  }

  private func updateScanProgress(_ transform: simd_float4x4, at time: TimeInterval) {
    let forward = SIMD2<Float>(-transform.columns.2.x, -transform.columns.2.z)
    guard simd_length(forward) > 0.35 else { return }
    let yaw = atan2(forward.x, forward.y)
    guard let previous = scanYaw, let previousTime = scanYawTime else {
      scanYaw = yaw
      scanYawTime = time
      return
    }
    let dt = Float(time - previousTime)
    let delta = atan2(sin(yaw - previous), cos(yaw - previous))
    scanYaw = yaw
    scanYawTime = time

    // REJECT ON RATE, NOT ON PER-SAMPLE ANGLE.
    //
    // This used to be `abs(delta) < 0.35`, a flat 20-degrees-per-sample cap. The frame
    // pump is throttled to 20Hz but RoomPlan is heavy and it runs slower under load, so
    // 20 degrees per sample is an ordinary brisk turn rather than a glitch. Every sample
    // over the cap was discarded while `scanYaw` still advanced, so that rotation was
    // lost for good: a real 270-degree turn reported closer to 210.
    //
    // What the guard is actually for is an ARKit relocalisation jump, where yaw changes
    // discontinuously. A rate test catches that and nothing else - no human turns a phone
    // at 690 degrees per second on purpose.
    guard dt > 0, abs(delta) / dt <= Self.maxTurnRateRadians else { return }

    if scanDirection == 0 {
      // Sum until the intent is unambiguous, rather than trusting one sample. There is no
      // minimum-delta floor any more: the old `abs(delta) > 0.001` threw away every sample
      // below 0.057 degrees, which at 20Hz is 1.1 deg/s, so the slow steady sweep the app
      // asks for accumulated nothing. Tremor is unbiased and cancels in this sum.
      scanDirectionEvidence += delta
      guard abs(scanDirectionEvidence) >= Self.directionLatchRadians else { return }
      scanDirection = scanDirectionEvidence >= 0 ? 1 : -1
      // Credit the rotation already gathered so the first ~7° is not thrown away.
      scanDegrees = abs(scanDirectionEvidence) * 180 / .pi
    } else {
      let directed = delta * scanDirection
      scanDegrees = min(360, max(0, scanDegrees + directed * 180 / .pi))
    }
    let bucket = Int(scanDegrees / 10)
    if bucket != reportedScanBucket {
      reportedScanBucket = bucket
      let progress = min(scanDegrees, 270)
      let message = scanDegrees >= 270
        ? "Rotation complete. Aim toward any room boundary not yet detected."
        : "Room measurement: \(Int(progress))° / 270°. Turn steadily in one direction."
      onStatus(["code": "scan_progress",
        "message": message,
        "scanDegrees": scanDegrees, "wallCount": scanWalls, "floorCount": scanFloors])
    }
    if scanDegrees >= 270, scanWalls >= 3 {
      finishRoomCapture(message: "Room coverage complete. Building the room…")
    }
  }

  private func finishRoomCapture(message: String) {
    guard mode == "scan" else { return }
    mode = "processing"
    onStatus(["code": "scan_complete", "message": message, "scanDegrees": scanDegrees,
      "wallCount": scanWalls, "floorCount": scanFloors])
    capture?.stop(pauseARSession: false)
    watchProcessing(epoch: generation)
  }

  /**
   Keeps "Building the room…" honest.

   `RoomBuilder` legitimately takes tens of seconds on a large scan, but nothing here
   bounded it and nothing reported progress — so a session that never produced a result
   sat on that one string indefinitely with no way out and nothing to diagnose from.
   Heartbeats say it is still working; the deadline turns a hang into a failure the user
   can act on. Every timer checks the generation, so a superseded scan's timer is inert.
   */
  private func watchProcessing(epoch: Int) {
    let started = Date()
    for delay in [20.0, 45.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self, self.mode == "processing", self.generation == epoch else { return }
        self.onStatus(["code": "scan_complete",
          "message": "Still building the room — \(Int(Date().timeIntervalSince(started)))s. Large rooms take longer.",
          "scanDegrees": self.scanDegrees, "wallCount": self.scanWalls, "floorCount": self.scanFloors])
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 120.0) { [weak self] in
      guard let self, self.mode == "processing", self.generation == epoch else { return }
      self.mode = "failed"
      self.onStatus(["code": "failed",
        "message": "Building the room did not finish within two minutes. Scan again, moving more slowly and keeping walls in view."])
    }
  }

  private func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  private struct HandDetection {
    let point: CGPoint
    let rawPoint: CGPoint
    let confidence: Double
    let pinchRatio: Double?
  }

  private func resetHandTracking() {
    processing = false
    lastHandSample = -.infinity
    handProcessed = 0
    handDropped = 0
    handActive = false
    handStreak = 0
    lastGoodHandTime = nil
    filteredHand = nil
    lastFilterTime = nil
    pinching = false
    pinchStreak = 0
  }

  private func acceptHand(_ detection: HandDetection?, timestamp: TimeInterval) -> [String: Any] {
    let inside = detection.map {
      (0...1).contains($0.point.x) && (0...1).contains($0.point.y)
    } ?? false
    let usable = inside ? detection : nil

    if handActive {
      if let usable, usable.confidence >= 0.35 {
        lastGoodHandTime = timestamp
        filteredHand = smooth(usable.point, timestamp: timestamp)
      } else if lastGoodHandTime.map({ timestamp - $0 > 0.35 }) ?? true {
        handActive = false
        handStreak = 0
        filteredHand = nil
        lastFilterTime = nil
      }
    } else if let usable, usable.confidence >= 0.6 {
      handStreak += 1
      if handStreak >= 2 {
        handActive = true
        lastGoodHandTime = timestamp
        filteredHand = usable.point
        lastFilterTime = timestamp
      }
    } else {
      handStreak = 0
    }

    if let ratio = usable?.pinchRatio, usable?.confidence ?? 0 >= 0.4 {
      if pinching {
        if ratio > 0.55 { pinching = false; pinchStreak = 0 }
      } else if ratio < 0.35 {
        pinchStreak += 1
        if pinchStreak >= 2 { pinching = true }
      } else {
        pinchStreak = 0
      }
    } else {
      pinching = false
      pinchStreak = 0
    }

    // WHY THERE IS NO CURSOR HAS TO BE ANSWERABLE FROM JAVASCRIPT.
    //
    // `x`/`y` only exist once the hand is active, and the fields below used to be gated on
    // `usable`, which already requires the point to be in view. So "Vision saw nothing",
    // "saw a hand but its point landed outside the viewport" and "saw it but confidence
    // was under the gate" all arrived as an identical `visible: false, confidence: 0`, and
    // a dead hand cursor could not be diagnosed without a native debugger.
    //
    // These report the detection as it was, before any gate.
    var result: [String: Any] = [
      "visible": handActive,
      "pinching": pinching,
      "confidence": usable?.confidence ?? 0,
      "pinchRatio": usable?.pinchRatio ?? -1,
      "processed": handProcessed,
      "dropped": handDropped,
      "latencyMs": 0,
      "detected": detection != nil,
      "inView": inside,
      "rawConfidence": detection?.confidence ?? 0,
    ]
    if let detection {
      // Unconditional: the out-of-view case is exactly the one worth seeing.
      result["rawX"] = detection.rawPoint.x
      result["rawY"] = detection.rawPoint.y
      result["displayX"] = detection.point.x
      result["displayY"] = detection.point.y
    }
    if handActive, let point = filteredHand {
      result["x"] = point.x
      result["y"] = point.y
    }
    return result
  }

  private func smooth(_ point: CGPoint, timestamp: TimeInterval) -> CGPoint {
    guard let previous = filteredHand, let previousTime = lastFilterTime else {
      lastFilterTime = timestamp
      return point
    }
    let dt = timestamp - previousTime
    guard dt > 0, dt < 1 else {
      lastFilterTime = timestamp
      return point
    }
    let speed = hypot(point.x - previous.x, point.y - previous.y) / dt
    let cutoff = 0.8 + 3.0 * speed
    let tau = 1.0 / (2.0 * Double.pi * cutoff)
    let alpha = dt / (dt + tau)
    lastFilterTime = timestamp
    return CGPoint(x: previous.x + alpha * (point.x - previous.x),
                   y: previous.y + alpha * (point.y - previous.y))
  }

  private func visionOrientation(_ orientation: UIInterfaceOrientation) -> CGImagePropertyOrientation {
    switch orientation {
    case .portrait: return .right
    case .portraitUpsideDown: return .left
    case .landscapeLeft: return .up
    case .landscapeRight: return .down
    default: return .right
    }
  }

  /// Vision returns points in the EXIF-oriented image. ARFrame's display
  /// transform expects points in the captured buffer's native image space.
  private func rawImagePoint(_ point: CGPoint,
                             orientation: CGImagePropertyOrientation) -> CGPoint {
    switch orientation {
    case .up: return point
    case .down: return CGPoint(x: 1 - point.x, y: 1 - point.y)
    case .right: return CGPoint(x: point.y, y: 1 - point.x)
    case .left: return CGPoint(x: 1 - point.y, y: point.x)
    case .upMirrored: return CGPoint(x: 1 - point.x, y: point.y)
    case .downMirrored: return CGPoint(x: point.x, y: 1 - point.y)
    case .rightMirrored: return CGPoint(x: 1 - point.y, y: 1 - point.x)
    case .leftMirrored: return CGPoint(x: point.y, y: point.x)
    @unknown default: return point
    }
  }
}
