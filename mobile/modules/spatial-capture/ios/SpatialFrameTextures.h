#import <Foundation/Foundation.h>
#import <ARKit/ARKit.h>

NS_ASSUME_NONNULL_BEGIN
// Development feasibility bridge. Call from main; GL work stays on Expo's GL queue.
// No pixel bytes cross the JavaScript bridge. Three concurrent leases maximum.
@interface SpatialFrameTextures : NSObject
- (void)acquireFrame:(ARFrame *)frame
          contextId:(NSNumber *)contextId
           metadata:(NSDictionary *)metadata
         completion:(void (^)(NSDictionary * _Nullable))completion
    NS_SWIFT_NAME(acquire(frame:contextId:metadata:completion:));
- (void)releaseLease:(NSString *)lease NS_SWIFT_NAME(release(lease:));
- (void)invalidate;
// Only when the owning JavaScript module is destroyed, never during view changes.
- (void)dispose;
@end
NS_ASSUME_NONNULL_END
