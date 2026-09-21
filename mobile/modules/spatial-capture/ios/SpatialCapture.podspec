Pod::Spec.new do |s|
  s.name = 'SpatialCapture'
  s.version = '0.1.0'
  s.summary = 'Session-owned RoomPlan and tracked camera bridge'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Dex'
  s.homepage = 'https://example.invalid/dex'
  s.platforms = { :ios => '17.0' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoGL', '57.0.2'
  s.frameworks = 'ARKit', 'RoomPlan', 'SceneKit', 'Vision', 'OpenGLES', 'CoreVideo'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
