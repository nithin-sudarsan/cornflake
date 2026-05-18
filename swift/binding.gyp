{
  "targets": [
    {
      "target_name": "cornflake_capture",
      "sources": ["CornflakeCapture/CornflakeCapture.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!":    ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "OTHER_CFLAGS":          ["-fobjc-arc"],
        "OTHER_CPLUSPLUSFLAGS":  ["-fobjc-arc", "-std=c++17"],
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_ENABLE_OBJC_ARC":  "YES",
        "GCC_ENABLE_CPP_EXCEPTIONS":    "YES",
        "CLANG_ENABLE_OBJC_EXCEPTIONS": "YES"
      },
      "link_settings": {
        "libraries": [
          "-framework ScreenCaptureKit",
          "-framework AVFoundation",
          "-framework CoreAudio",
          "-framework Foundation",
          "-framework CoreMedia"
        ]
      },
      "conditions": [["OS=='mac'", {}]]
    }
  ]
}
