# xype motion runtime

This folder is bundled with the app and is where the VapourSynth runtime belongs.

Expected Windows layout after auto-install:

```txt
motion-runtime/
  vspipe.exe
  xype_motion.vpy
  vapoursynth.dll / python runtime dlls
  plugins/
    mvtools*.dll
    bestsource*.dll or ffms2*.dll / lsmas*.dll
```

The app uses `xype_motion.vpy` through `vspipe.exe` and pipes y4m output into FFmpeg.

`xype_motion.vpy` uses only built-in VapourSynth + MVTools plugins for:
- Source loading (BestSource/FFMS2/L-SMASH)
- Motion interpolation via `mv.FlowFPS`
- Motion blur via `mv.FlowBlur`
- Frame blending via `std.AverageFrames`

No external Python scripts (havsfunc, blending, etc.) are required.

The actual runtime binaries are downloaded automatically on first use via the in-app installer, or can be bundled manually.
