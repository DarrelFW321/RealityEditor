#import "SpatialFrameTextures.h"
#import <ExpoGL/EXGLContext.h>
#import <ExpoGL/EXGLObjectManager.h>
#import <OpenGLES/ES3/gl.h>
#import <UIKit/UIKit.h>

// This method exists in pinned expo-gl 57.0.2 but is not in its public header.
// Keep the dependency explicit here; no edits to node_modules are required.
@interface EXGLObjectManager (SpatialContextLookup)
- (EXGLContext *)getContextWithId:(NSNumber *)contextId;
@end

@interface SpatialTextureLease : NSObject
@property(nonatomic, strong) EXGLContext *context;
@property(nonatomic, strong) NSMutableArray<NSNumber *> *names;
@property(nonatomic, strong) NSMutableArray<NSNumber *> *objects;
@property(nonatomic, assign) BOOL releasing;
@property(nonatomic, assign) BOOL delivered;
@property(nonatomic, assign) BOOL releaseRequested;
@end
@implementation SpatialTextureLease
- (instancetype)init {
  if ((self = [super init])) {
    _names = [NSMutableArray new];
    _objects = [NSMutableArray new];
  }
  return self;
}
@end

@implementation SpatialFrameTextures {
  NSMutableDictionary<NSString *, SpatialTextureLease *> *_leases;
  NSUInteger _generation;
  NSUInteger _dropped;
  BOOL _suspended;
  id _suspendObserver;
  id _resumeObserver;
  BOOL _disposing;
  SpatialFrameTextures *_disposalHold;
}
- (instancetype)init {
  if ((self = [super init])) {
    _leases = [NSMutableDictionary new];
    _suspended = NO;
    __weak SpatialFrameTextures *weakSelf = self;
    _suspendObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:UIApplicationWillResignActiveNotification object:nil queue:NSOperationQueue.mainQueue
      usingBlock:^(NSNotification *note) {
        SpatialFrameTextures *owner = weakSelf;
        if (owner) owner->_suspended = YES;
        // Expo drains its GL queue on this same notification. Never enqueue new
        // cleanup after that drain while iOS prohibits background GPU work.
      }];
    _resumeObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:UIApplicationDidBecomeActiveNotification object:nil queue:NSOperationQueue.mainQueue
      usingBlock:^(NSNotification *note) {
        SpatialFrameTextures *owner = weakSelf;
        if (!owner) return;
        owner->_suspended = NO;
        for (NSString *token in owner->_leases.allKeys)
          if (owner->_leases[token].releaseRequested) [owner releaseLease:token];
      }];
  }
  return self;
}
- (void)dealloc {
  if (_suspendObserver) [NSNotificationCenter.defaultCenter removeObserver:_suspendObserver];
  if (_resumeObserver) [NSNotificationCenter.defaultCenter removeObserver:_resumeObserver];
}

// The source uses ARKit's raw sensor orientation. JS applies the inverse display
// transform from THIS frame. Respect padded row strides, including Float32 depth.
static NSDictionary *Upload(CVPixelBufferRef buffer, size_t plane,
                            GLint internalFormat, GLenum format, GLenum type,
                            size_t bytesPerPixel, SpatialTextureLease *lease) {
  if (!buffer || CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess)
    return nil;
  BOOL planar = CVPixelBufferIsPlanar(buffer);
  size_t width = planar ? CVPixelBufferGetWidthOfPlane(buffer, plane) : CVPixelBufferGetWidth(buffer);
  size_t height = planar ? CVPixelBufferGetHeightOfPlane(buffer, plane) : CVPixelBufferGetHeight(buffer);
  size_t stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) : CVPixelBufferGetBytesPerRow(buffer);
  void *bytes = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, plane) : CVPixelBufferGetBaseAddress(buffer);
  if (!bytes || !width || !height || stride % bytesPerPixel != 0) {
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    return nil;
  }
  GLuint name = 0;
  glGenTextures(1, &name);
  glBindTexture(GL_TEXTURE_2D, name);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glPixelStorei(GL_UNPACK_ROW_LENGTH, (GLint)(stride / bytesPerPixel));
  glTexImage2D(GL_TEXTURE_2D, 0, internalFormat, (GLsizei)width, (GLsizei)height,
               0, format, type, bytes);
  CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
  if (glGetError() != GL_NO_ERROR) { glDeleteTextures(1, &name); return nil; }
  EXGLObjectId object = EXGLContextCreateObject(lease.context.contextId);
  if (!object) { glDeleteTextures(1, &name); return nil; }
  EXGLContextMapObject(lease.context.contextId, object, name);
  [lease.names addObject:@(name)];
  [lease.objects addObject:@(object)];
  return @{ @"id": @(object), @"width": @(width), @"height": @(height) };
}

- (void)acquireFrame:(ARFrame *)frame contextId:(NSNumber *)contextId
           metadata:(NSDictionary *)metadata completion:(void (^)(NSDictionary *))completion {
  NSAssert([NSThread isMainThread], @"Frame leases are main-thread owned");
  if (_suspended || _disposing) { completion(nil); return; }
  if (_leases.count >= 3) { _dropped++; completion(nil); return; }
  EXGLContext *context = [EXGLObjectManager.shared getContextWithId:contextId];
  if (!context || !context.isInitialized || context.eaglCtx.API != kEAGLRenderingAPIOpenGLES3) {
    completion(nil); return;
  }
  // Fail closed for formats not covered by the shader. Camera range is recorded.
  OSType format = CVPixelBufferGetPixelFormatType(frame.capturedImage);
  if (format != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange &&
      format != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) { completion(nil); return; }
  NSUInteger epoch = _generation;
  NSString *token = NSUUID.UUID.UUIDString;
  SpatialTextureLease *lease = [SpatialTextureLease new];
  lease.context = context;
  _leases[token] = lease; // Reserve before scheduling: queued uploads also count.
  [context runAsync:^{
    GLint binding, alignment, rowLength, unpackBuffer, skipRows, skipPixels;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
    glGetIntegerv(GL_UNPACK_ALIGNMENT, &alignment);
    glGetIntegerv(GL_UNPACK_ROW_LENGTH, &rowLength);
    glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpackBuffer);
    glGetIntegerv(GL_UNPACK_SKIP_ROWS, &skipRows);
    glGetIntegerv(GL_UNPACK_SKIP_PIXELS, &skipPixels);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    NSMutableDictionary *textures = [NSMutableDictionary new];
    NSDictionary *y = Upload(frame.capturedImage, 0, GL_R8, GL_RED, GL_UNSIGNED_BYTE, 1, lease);
    NSDictionary *uv = Upload(frame.capturedImage, 1, GL_RG8, GL_RG, GL_UNSIGNED_BYTE, 2, lease);
    if (y) textures[@"luma"] = y;
    if (uv) textures[@"chroma"] = uv;
    // Unsmooth sceneDepth is paired with this captured frame; no independent streams.
    ARDepthData *depth = frame.sceneDepth;
    if (depth && CVPixelBufferGetPixelFormatType(depth.depthMap) == kCVPixelFormatType_DepthFloat32) {
      NSDictionary *d = Upload(depth.depthMap, 0, GL_R32F, GL_RED, GL_FLOAT, 4, lease);
      if (d) textures[@"depth"] = d;
      if (depth.confidenceMap &&
          CVPixelBufferGetPixelFormatType(depth.confidenceMap) == kCVPixelFormatType_OneComponent8) {
        NSDictionary *c = Upload(depth.confidenceMap, 0, GL_R8, GL_RED, GL_UNSIGNED_BYTE, 1, lease);
        if (c) textures[@"confidence"] = c;
      }
    }
    if (frame.segmentationBuffer &&
        CVPixelBufferGetPixelFormatType(frame.segmentationBuffer) == kCVPixelFormatType_OneComponent8) {
      NSDictionary *p = Upload(frame.segmentationBuffer, 0, GL_R8, GL_RED, GL_UNSIGNED_BYTE, 1, lease);
      if (p) textures[@"foreground"] = p;
    }
    glBindTexture(GL_TEXTURE_2D, (GLuint)binding);
    glPixelStorei(GL_UNPACK_ALIGNMENT, alignment);
    glPixelStorei(GL_UNPACK_ROW_LENGTH, rowLength);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, (GLuint)unpackBuffer);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, skipRows);
    glPixelStorei(GL_UNPACK_SKIP_PIXELS, skipPixels);
    glFinish(); // Conservative feasibility fence; profile before replacing with GPU sync.
    CFTypeRef matrix = CVBufferGetAttachment(frame.capturedImage, kCVImageBufferYCbCrMatrixKey, NULL);
    BOOL bt709 = matrix && CFEqual(matrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2);
    NSMutableDictionary *result = [metadata mutableCopy];
    result[@"leaseId"] = token;
    result[@"contextId"] = contextId;
    result[@"textures"] = textures;
    result[@"videoRange"] = @(format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
    result[@"bt709"] = @(bt709);
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self->_suspended || self->_generation != epoch || self->_leases[token] != lease || !y || !uv) {
        [self releaseLease:token]; completion(nil); return;
      }
      result[@"leasedSlots"] = @(self->_leases.count);
      result[@"dropped"] = @(self->_dropped);
      result[@"nativeAgeMs"] = @((NSProcessInfo.processInfo.systemUptime - frame.timestamp) * 1000);
      lease.delivered = YES;
      completion(result);
    });
  }];
}

- (void)releaseLease:(NSString *)token {
  NSAssert([NSThread isMainThread], @"Frame leases are main-thread owned");
  SpatialTextureLease *lease = _leases[token];
  if (!lease || lease.releasing) return;
  lease.releaseRequested = YES;
  if (_suspended) return;
  lease.releasing = YES;
  // Keep a slot reserved until the GPU cleanup has actually finished.
  [lease.context runAsync:^{
    EXGLContextFlush(lease.context.contextId);
    glFinish();
    for (NSNumber *object in lease.objects)
      EXGLContextDestroyObject(lease.context.contextId, object.unsignedIntValue);
    for (NSNumber *number in lease.names) {
      GLuint name = number.unsignedIntValue;
      glDeleteTextures(1, &name);
    }
    [lease.objects removeAllObjects];
    [lease.names removeAllObjects];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self->_leases[token] == lease) [self->_leases removeObjectForKey:token];
      if (self->_leases.count == 0) self->_disposalHold = nil;
    });
  }];
}
- (void)invalidate {
  NSAssert([NSThread isMainThread], @"Frame leases are main-thread owned");
  _generation++;
  // Cancel queued uploads, but JS may still be sampling a delivered lease. Its
  // explicit release (or module teardown) is the ownership fence, not view expiry.
  for (NSString *token in _leases.allKeys)
    if (!_leases[token].delivered) [self releaseLease:token];
}
- (void)dispose {
  NSAssert([NSThread isMainThread], @"Frame leases are main-thread owned");
  _disposing = YES;
  // If teardown happens in the background, retain the bounded pool until its
  // resume observer can perform deferred cleanup on the GPU queue.
  if (_leases.count > 0) _disposalHold = self;
  _generation++;
  for (NSString *token in _leases.allKeys) [self releaseLease:token];
}
@end
