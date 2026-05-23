import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { cn } from "@/lib/utils";
import { SiTiktok } from "react-icons/si";
import {
  PiFilmSlateDuotone,
  PiFilmReelDuotone,
  PiGearSixDuotone,
  PiFolderOpenDuotone,
  PiCheckCircleFill,
  PiXCircleFill,
  PiSpinnerGapBold,
  PiWarningCircleDuotone,
  PiScissorsDuotone,
  PiPlayFill,
  PiPauseFill,
  PiSparkleDuotone,
  PiArrowsClockwiseDuotone,
  PiDownloadSimpleDuotone,
  PiArrowCounterClockwiseDuotone,
} from "react-icons/pi";

interface FpsConfig { fps: number; scale: number; }
interface ProcessResult { success: boolean; message: string; output_path?: string; }
interface Seg { id: string; inPoint: number; outPoint: number; }
type View = "tiktok-quality" | "tiktok-clean" | "trim" | "render" | "settings";

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];

const fmt = (t: number) => {
  if (!isFinite(t) || isNaN(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
};

export default function App() {
  const [view, setView] = useState<View>("tiktok-quality");
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffmpegValid, setFfmpegValid] = useState<boolean | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // ── Updater state ──
  type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "uptodate" | "error";
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string | null } | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState("");
  const pendingUpdate = useRef<Update | null>(null);

  // ── TikTok Quality state ──
  const [fpsConfigs, setFpsConfigs] = useState<FpsConfig[]>([]);
  const [inputFile, setInputFile] = useState("");
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [detectingFps, setDetectingFps] = useState(false);
  const [selectedFps, setSelectedFps] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);

  // ── TikTok Clean state ──
  const [cleanFile, setCleanFile] = useState("");
  const [cleanProcessing, setCleanProcessing] = useState(false);
  const [cleanResult, setCleanResult] = useState<ProcessResult | null>(null);

  // ── Trim state ──
  const [trimFile, setTrimFile] = useState("");
  const [trimVideoSrc, setTrimVideoSrc] = useState("");
  const [trimDuration, setTrimDuration] = useState(0);
  const [trimCurrentTime, setTrimCurrentTime] = useState(0);
  const [trimSegs, setTrimSegs] = useState<Seg[]>([]);
  const [trimPendingIn, setTrimPendingIn] = useState<number | null>(null);
  const [trimPlaying, setTrimPlaying] = useState(false);
  const [trimProcessing, setTrimProcessing] = useState(false);
  const [trimResult, setTrimResult] = useState<ProcessResult | null>(null);
  const trimVideoRef = useRef<HTMLVideoElement>(null);

  // ── Smoothie state ──
  const [renderFile, setRenderFile] = useState("");
  const [renderInputFps, setRenderInputFps] = useState<number | null>(null);
  const [renderDetecting, setRenderDetecting] = useState(false);
  const [renderProcessing, setRenderProcessing] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderResult, setRenderResult] = useState<ProcessResult | null>(null);

  // Persistent Smoothie settings
  const [renderOutputFps, setRenderOutputFpsState] = useState(() => Number(localStorage.getItem("smth.outFps") ?? "60"));
  // blurAmount: 0.0–1.0 (same as blur/tekno "blur amount"; 1.0 = 360° shutter = full blur)
  const [blurAmount, setBlurAmountState] = useState(() => {
    const stored = localStorage.getItem("smth.blurAmount");
    if (stored !== null) return Number(stored);
    const old = localStorage.getItem("smth.shutter");
    return old !== null ? Number(old) / 360 : 1.0;
  });
  const [blendWeighting, setBlendWeightingState] = useState(() => localStorage.getItem("smth.weighting") ?? "equal");
  const [renderEncoder, setRenderEncoderState] = useState(() => localStorage.getItem("smth.encoder") ?? "libx264");
  const [renderCrf, setRenderCrfState] = useState(() => Number(localStorage.getItem("smth.crf") ?? "17"));
  const [interpolateOn, setInterpolateOnState] = useState(() => localStorage.getItem("smth.interpolateOn") === "true");
  const [interpolateFpsValue, setInterpolateFpsValueState] = useState(() => Number(localStorage.getItem("smth.interpFps") ?? "360"));

  const setRenderOutputFps = (v: number) => { setRenderOutputFpsState(v); localStorage.setItem("smth.outFps", String(v)); };
  const setBlurAmount = (v: number) => { setBlurAmountState(v); localStorage.setItem("smth.blurAmount", String(v)); };
  const setBlendWeighting = (v: string) => { setBlendWeightingState(v); localStorage.setItem("smth.weighting", v); };
  const setRenderEncoder = (v: string) => { setRenderEncoderState(v); localStorage.setItem("smth.encoder", v); };
  const setRenderCrf = (v: number) => { setRenderCrfState(v); localStorage.setItem("smth.crf", String(v)); };
  const setInterpolateOn = (v: boolean) => { setInterpolateOnState(v); localStorage.setItem("smth.interpolateOn", String(v)); };
  const setInterpolateFpsValue = (v: number) => { setInterpolateFpsValueState(v); localStorage.setItem("smth.interpFps", String(v)); };

  const [renderTimescale, setRenderTimescaleState] = useState(() => Number(localStorage.getItem("smth.timescale") ?? "1"));
  const setRenderTimescale = (v: number) => { setRenderTimescaleState(v); localStorage.setItem("smth.timescale", String(v)); };
  const [customWeights, setCustomWeightsState] = useState(() => localStorage.getItem("smth.customWeights") ?? "");
  const setCustomWeights = (v: string) => { setCustomWeightsState(v); localStorage.setItem("smth.customWeights", v); };

  const handleFileRef = useRef<(path: string) => void>(() => { });

  useEffect(() => {
    invoke<FpsConfig[]>("get_fps_configs").then(setFpsConfigs).catch(console.error);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow()
      .onDragDropEvent((e) => {
        const { type } = e.payload;
        if (type === "enter" || type === "over") setIsDragOver(true);
        else if (type === "leave") setIsDragOver(false);
        else if (type === "drop") {
          setIsDragOver(false);
          const paths = (e.payload as { type: "drop"; paths: string[] }).paths;
          if (paths?.[0]) handleFileRef.current(paths[0]);
        }
      })
      .then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Load ffmpeg path from persistent config file on startup
  useEffect(() => {
    invoke<{ ffmpeg_path: string }>("load_config")
      .then(config => {
        const path = config.ffmpeg_path || localStorage.getItem("ffmpegPath") || "";
        if (path) setFfmpegPath(path);
      })
      .catch(() => {
        const stored = localStorage.getItem("ffmpegPath") ?? "";
        if (stored) setFfmpegPath(stored);
      });
  }, []);

  useEffect(() => {
    if (!ffmpegPath) { setFfmpegValid(null); return; }
    invoke<boolean>("validate_ffmpeg", { ffmpegPath })
      .then(setFfmpegValid)
      .catch(() => setFfmpegValid(false));
  }, [ffmpegPath]);

  // ── Trim: markIn / markOut with stable refs ──
  const markInRef = useRef<() => void>(() => { });
  const markOutRef = useRef<() => void>(() => { });

  const markIn = () => {
    const v = trimVideoRef.current;
    if (!v) return;
    setTrimPendingIn(v.currentTime);
  };

  const markOut = () => {
    const v = trimVideoRef.current;
    if (!v) return;
    if (trimPendingIn === null) return;
    const t = v.currentTime;
    if (t <= trimPendingIn) return;
    setTrimSegs(prev => [...prev, { id: `${Date.now()}`, inPoint: trimPendingIn, outPoint: t }]);
    setTrimPendingIn(null);
  };

  markInRef.current = markIn;
  markOutRef.current = markOut;

  useEffect(() => {
    if (view !== "trim" || !trimFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        const v = trimVideoRef.current;
        if (!v) return;
        v.paused ? v.play() : v.pause();
      } else if (e.code === "KeyI") {
        e.preventDefault();
        markInRef.current();
      } else if (e.code === "KeyO") {
        e.preventDefault();
        markOutRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, trimFile]);

  const saveFfmpegPath = (val: string) => {
    setFfmpegPath(val);
    localStorage.setItem("ffmpegPath", val);
    invoke("save_config", { config: { ffmpeg_path: val } }).catch(console.error);
  };

  // Check for updates once on startup (silently)
  useEffect(() => {
    setUpdateStatus("checking");
    checkUpdate()
      .then(update => {
        if (update?.available) {
          pendingUpdate.current = update;
          setUpdateInfo({ version: update.version, body: update.body ?? null });
          setUpdateStatus("available");
        } else {
          setUpdateStatus("uptodate");
        }
      })
      .catch(() => setUpdateStatus("idle"));
  }, []);

  const doCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateInfo(null);
    setUpdateError("");
    try {
      const update = await checkUpdate();
      if (update?.available) {
        pendingUpdate.current = update;
        setUpdateInfo({ version: update.version, body: update.body ?? null });
        setUpdateStatus("available");
      } else {
        setUpdateStatus("uptodate");
      }
    } catch (e) {
      setUpdateError(String(e));
      setUpdateStatus("error");
    }
  };

  const doInstallUpdate = async () => {
    if (!pendingUpdate.current) return;
    setUpdateStatus("downloading");
    setUpdateProgress(0);
    let downloaded = 0;
    let total = 0;
    try {
      await pendingUpdate.current.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) setUpdateProgress(Math.round(downloaded / total * 100));
        } else if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });
      setUpdateStatus("ready");
    } catch (e) {
      setUpdateError(String(e));
      setUpdateStatus("error");
    }
  };

  const pickFfmpeg = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Executable", extensions: ["exe"] }] });
      if (typeof sel === "string") saveFfmpegPath(sel);
    } catch (e) { console.error(e); }
  };

  const detectFps = async (path: string) => {
    if (!ffmpegPath) return;
    setDetectingFps(true);
    try {
      const fps = await invoke<number>("get_video_fps", { ffmpegPath, videoPath: path });
      setDetectedFps(fps);
      const match = [60, 120, 240].find(v => Math.abs(v - Math.round(fps)) <= 5) ?? null;
      setSelectedFps(match);
    } catch (e) {
      console.error("FPS detection failed:", e);
    } finally {
      setDetectingFps(false);
    }
  };

  const handleTiktokFile = async (path: string) => {
    setInputFile(path);
    setResult(null);
    setDetectedFps(null);
    setSelectedFps(null);
    await detectFps(path);
  };

  const pickVideo = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: VIDEO_EXTS }] });
      if (typeof sel === "string") await handleTiktokFile(sel);
    } catch (e) { console.error(e); }
  };

  const processVideo = async () => {
    if (!ffmpegPath || !inputFile || selectedFps === null) return;
    const config = fpsConfigs.find(c => c.fps === selectedFps);
    if (!config) return;
    setProcessing(true);
    setResult(null);
    try {
      const res = await invoke<ProcessResult>("process_video", {
        ffmpegPath, inputPath: inputFile, fps: selectedFps, scale: config.scale,
      });
      if (res.success && res.output_path) {
        setSuccessModal({ message: res.message, outputPath: res.output_path });
      } else {
        setResult(res);
      }
    } catch (e) {
      setResult({ success: false, message: `Error: ${e}` });
    } finally {
      setProcessing(false);
    }
  };

  const handleTrimFile = (path: string) => {
    setTrimFile(path);
    setTrimVideoSrc(convertFileSrc(path));
    setTrimDuration(0);
    setTrimCurrentTime(0);
    setTrimSegs([]);
    setTrimPendingIn(null);
    setTrimPlaying(false);
    setTrimResult(null);
  };

  const pickTrimVideo = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: VIDEO_EXTS }] });
      if (typeof sel === "string") handleTrimFile(sel);
    } catch (e) { console.error(e); }
  };

  const handleCleanFile = (path: string) => {
    setCleanFile(path);
    setCleanResult(null);
  };

  const pickCleanVideo = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: ["mp4"] }] });
      if (typeof sel === "string") handleCleanFile(sel);
    } catch (e) { console.error(e); }
  };

  const patchClean = async () => {
    if (!cleanFile) return;
    setCleanProcessing(true);
    setCleanResult(null);
    try {
      const res = await invoke<ProcessResult>("patch_tiktok_clean", { inputPath: cleanFile });
      if (res.success && res.output_path) {
        setSuccessModal({ message: res.message, outputPath: res.output_path });
      } else {
        setCleanResult(res);
      }
    } catch (e) {
      setCleanResult({ success: false, message: `Error: ${e}` });
    } finally {
      setCleanProcessing(false);
    }
  };

  const exportClip = async () => {
    if (!ffmpegPath || trimSegs.length === 0) return;
    setTrimProcessing(true);
    setTrimResult(null);
    try {
      const sorted = [...trimSegs].sort((a, b) => a.inPoint - b.inPoint);
      const res = await invoke<ProcessResult>("export_segments", {
        ffmpegPath,
        inputPath: trimFile,
        segments: sorted.map(s => ({ start: s.inPoint, end: s.outPoint })),
      });
      if (res.success && res.output_path) {
        setSuccessModal({ message: res.message, outputPath: res.output_path });
      } else {
        setTrimResult(res);
      }
    } catch (e) {
      setTrimResult({ success: false, message: `Error: ${e}` });
    } finally {
      setTrimProcessing(false);
    }
  };

  // ── Render handlers ──
  const handleRenderFile = async (path: string) => {
    setRenderFile(path);
    setRenderInputFps(null);
    setRenderResult(null);
    if (!ffmpegPath) return;
    setRenderDetecting(true);
    try {
      const fps = await invoke<number>("get_video_fps", { ffmpegPath, videoPath: path });
      setRenderInputFps(fps);
    } catch { /* ignore */ } finally {
      setRenderDetecting(false);
    }
  };

  const pickRenderVideo = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: VIDEO_EXTS }] });
      if (typeof sel === "string") handleRenderFile(sel);
    } catch (e) { console.error(e); }
  };

  const processRender = async () => {
    if (!ffmpegPath || !renderFile || renderInputFps === null) return;
    const workingFps = interpolateOn && interpolateFpsValue > 0 ? interpolateFpsValue : renderInputFps;
    const framesBlended = Math.max(1, Math.round(workingFps / renderOutputFps * blurAmount));
    const effectiveWeighting = blendWeighting === "custom" ? customWeights : blendWeighting;
    setRenderProcessing(true);
    setRenderProgress(0);
    setRenderResult(null);
    const unlisten = await listen<number>("render-progress", (e) => {
      setRenderProgress(e.payload);
    });
    try {
      const res = await invoke<ProcessResult>("render_video", {
        ffmpegPath,
        inputPath: renderFile,
        interpolateFps: interpolateOn ? interpolateFpsValue : 0,
        outputFps: renderOutputFps,
        framesToBlend: framesBlended,
        blendWeighting: effectiveWeighting,
        encoder: renderEncoder,
        crf: renderCrf,
        timescale: renderTimescale,
      });
      if (res.success && res.output_path) {
        setSuccessModal({ message: res.message, outputPath: res.output_path });
      } else {
        setRenderResult(res);
      }
    } catch (e) {
      setRenderResult({ success: false, message: `Error: ${e}` });
    } finally {
      unlisten();
      setRenderProcessing(false);
      setRenderProgress(null);
    }
  };

  if (view === "trim") {
    handleFileRef.current = handleTrimFile;
  } else if (view === "render") {
    handleFileRef.current = handleRenderFile;
  } else if (view === "tiktok-clean") {
    handleFileRef.current = handleCleanFile;
  } else {
    handleFileRef.current = handleTiktokFile;
  }

  const [successModal, setSuccessModal] = useState<{ message: string; outputPath: string } | null>(null);

  const revealInExplorer = async (path: string) => {
    try { await invoke("reveal_in_explorer", { path }); } catch (e) { console.error(e); }
  };

  const canProcess = !!ffmpegValid && !!inputFile && selectedFps !== null && !processing;
  const canExport = !!ffmpegValid && trimSegs.length > 0 && !trimProcessing;
  const canRender = !!ffmpegValid && !!renderFile && renderInputFps !== null && !renderProcessing;
  const canClean = !!cleanFile && !cleanProcessing;
  const fileName = inputFile.split(/[\\/]/).pop() ?? "";
  const cleanFileName = cleanFile.split(/[\\/]/).pop() ?? "";
  const renderFileName = renderFile.split(/[\\/]/).pop() ?? "";
  const trimTotalLen = trimSegs.reduce((acc, s) => acc + (s.outPoint - s.inPoint), 0);
  const renderWorkingFps = interpolateOn && interpolateFpsValue > 0 ? interpolateFpsValue : (renderInputFps ?? renderOutputFps);
  const renderFramesBlended = Math.max(1, Math.round(renderWorkingFps / renderOutputFps * blurAmount));

  return (
    <div className="flex h-screen bg-background text-foreground font-sans antialiased select-none overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className="w-52 shrink-0 flex flex-col border-r border-border">
        <div className="h-12 px-4 flex items-center gap-2.5 border-b border-border">
          <img src="/logo.png" alt="xype" className="w-5 h-5 rounded-md shrink-0" />
          <span className="text-sm font-semibold tracking-tight">xype</span>
        </div>

        <nav className="flex-1 p-2 space-y-px">
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">Tools</p>
          <SidebarItem active={view === "tiktok-quality"} onClick={() => setView("tiktok-quality")} icon={<SiTiktok />}>
            TikTok Quality
          </SidebarItem>
          <SidebarItem active={view === "tiktok-clean"} onClick={() => setView("tiktok-clean")} icon={<PiSparkleDuotone />}>
            TikTok Clean
          </SidebarItem>
          <SidebarItem active={view === "trim"} onClick={() => setView("trim")} icon={<PiScissorsDuotone />}>
            Trim
          </SidebarItem>
          <SidebarItem active={view === "render"} onClick={() => setView("render")} icon={<PiFilmReelDuotone />}>
            Smoothie
          </SidebarItem>
        </nav>

        <div className="p-2 border-t border-border">
          <SidebarItem active={view === "settings"} onClick={() => setView("settings")} icon={<PiGearSixDuotone />}>
            Settings
            <span className="ml-auto flex items-center gap-1">
              {updateStatus === "available" && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 anim-scale-in" />
              )}
              {ffmpegValid === false && (
                <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0 anim-scale-in" />
              )}
            </span>
          </SidebarItem>
        </div>
      </aside>

      {/* ── Main ── */}
      <div key={view} className="flex-1 flex flex-col overflow-hidden anim-fade">

        {/* ─ TikTok Quality ─ */}
        {view === "tiktok-quality" && (
          <>
            <Header icon={<SiTiktok />} title="TikTok Quality" sub="FPS Scaler" />

            {/* Empty state — drop zone fills the height */}
            {!inputFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-8">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {/* Loaded state — spacious stacked layout, action at bottom */}
            {!!inputFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-8 gap-8">

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-4 px-5 py-4 rounded-2xl border border-border bg-accent/10 transition-colors hover:bg-accent/15">
                    <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center shrink-0">
                      <PiFilmSlateDuotone className="text-xl text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-semibold truncate">{fileName}</p>
                      <div className="mt-0.5 text-sm text-muted-foreground h-5 flex items-center">
                        {detectingFps && (
                          <span className="anim-fade flex items-center gap-1.5">
                            <PiSpinnerGapBold className="animate-spin" />Detecting FPS…
                          </span>
                        )}
                        {!detectingFps && detectedFps !== null && (
                          <span className="anim-fade">
                            Detected: <span className="text-foreground font-semibold">{Math.round(detectedFps)} fps</span>
                          </span>
                        )}
                        {!detectingFps && detectedFps === null && !ffmpegValid && (
                          <span className="anim-fade">Configure FFmpeg to detect FPS</span>
                        )}
                        {!detectingFps && detectedFps === null && ffmpegValid && (
                          <span className="anim-fade text-destructive">FPS detection failed</span>
                        )}
                      </div>
                    </div>
                    <button type="button"
                      onClick={() => { setInputFile(""); setDetectedFps(null); setSelectedFps(null); setResult(null); }}
                      className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-all duration-150 hover:scale-110 active:scale-90">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  {/* FPS selector */}
                  <div className="anim-slide-up space-y-4" style={{ animationDelay: "50ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Source FPS</p>
                    <div className="grid grid-cols-3 gap-3">
                      {fpsConfigs.map((cfg, i) => (
                        <button key={cfg.fps} type="button" onClick={() => setSelectedFps(cfg.fps)}
                          className={cn(
                            "anim-slide-up h-16 rounded-xl border font-medium flex flex-col items-center justify-center gap-0.5 transition-all duration-200 active:scale-[0.97]",
                            selectedFps === cfg.fps
                              ? "bg-foreground text-background border-foreground scale-[1.02]"
                              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                          )}
                          style={{ animationDelay: `${80 + i * 35}ms` }}>
                          <span className="text-2xl font-bold leading-none tabular-nums">{cfg.fps}</span>
                          <span className="text-[11px] font-normal opacity-50 mt-0.5">fps</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Push action to bottom */}
                  <div className="flex-1" />

                  {/* Process */}
                  <div className="anim-fade space-y-4" style={{ animationDelay: "200ms" }}>
                    <div className="border-t border-border" />
                    <button type="button" onClick={processVideo} disabled={!canProcess}
                      className={cn("w-full h-11 rounded-xl text-sm font-semibold transition-all duration-200",
                        canProcess
                          ? "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.98] hover:scale-[1.005]"
                          : "bg-accent/40 text-muted-foreground cursor-not-allowed")}>
                      {processing
                        ? <span className="flex items-center justify-center gap-2"><PiSpinnerGapBold className="animate-spin" />Processing…</span>
                        : "Process Video"}
                    </button>
                    {result && <ResultBanner result={result} />}
                  </div>

                </div>
              </main>
            )}
          </>
        )}

        {/* ─ TikTok Clean ─ */}
        {view === "tiktok-clean" && (
          <>
            <Header icon={<PiSparkleDuotone />} title="TikTok Clean" sub="Shark Patch" />

            {!cleanFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-8">
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickCleanVideo}
                    label="Drop MP4 here" hint="or click to browse · MP4 only" />
                </div>
              </main>
            )}

            {!!cleanFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-8 gap-8">

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-4 px-5 py-4 rounded-2xl border border-border bg-accent/10 transition-colors hover:bg-accent/15">
                    <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center shrink-0">
                      <PiFilmSlateDuotone className="text-xl text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-semibold truncate">{cleanFileName}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">Ready to patch</p>
                    </div>
                    <button type="button"
                      onClick={() => { setCleanFile(""); setCleanResult(null); }}
                      className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-all duration-150 hover:scale-110 active:scale-90">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  {/* What this does */}
                  <div className="anim-slide-up rounded-2xl border border-border bg-accent/5 px-5 py-4 space-y-1.5" style={{ animationDelay: "40ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">What happens</p>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      Writes <span className="font-mono text-foreground/80 text-[12px]">0x00000001</span> into the display matrix{" "}
                      <span className="font-mono text-foreground/80 text-[12px]">b</span> field of the{" "}
                      <span className="font-mono text-foreground/80 text-[12px]">mvhd</span> box.
                      TikTok's ingestion pipeline reads this non-standard value and routes the video through a lighter encode,
                      preserving quality instead of aggressively recompressing.
                    </p>
                    <p className="text-[12px] text-muted-foreground/50">No re-encode. Instant. Output plays identically in all players.</p>
                  </div>

                  <div className="flex-1" />

                  <div className="anim-fade space-y-4" style={{ animationDelay: "100ms" }}>
                    <div className="border-t border-border" />
                    <button type="button" onClick={patchClean} disabled={!canClean}
                      className={cn("w-full h-11 rounded-xl text-sm font-semibold transition-all duration-200",
                        canClean
                          ? "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.98] hover:scale-[1.005]"
                          : "bg-accent/40 text-muted-foreground cursor-not-allowed")}>
                      {cleanProcessing
                        ? <span className="flex items-center justify-center gap-2"><PiSpinnerGapBold className="animate-spin" />Patching…</span>
                        : "Patch & Save"}
                    </button>
                    {cleanResult && <ResultBanner result={cleanResult} />}
                  </div>

                </div>
              </main>
            )}
          </>
        )}

        {/* ─ Trim ─ */}
        {view === "trim" && (
          <>
            <Header icon={<PiScissorsDuotone />} title="Trim" sub="Lossless Cut" />

            {/* Empty state */}
            {!trimFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-8">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickTrimVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {/* Loaded state — true flex fill, video takes all spare height */}
            {!!trimFile && (
              <main className="flex-1 overflow-hidden flex flex-col">
                <div key="filled" className="flex-1 flex flex-col gap-4 p-6 min-h-0">

                  {/* Video — flex-1 fills remaining vertical space */}
                  <div className="anim-scale-in flex-1 min-h-[120px] rounded-2xl overflow-hidden bg-black border border-border">
                    <video
                      ref={trimVideoRef}
                      src={trimVideoSrc}
                      className="w-full h-full object-contain"
                      onLoadedMetadata={(e) => {
                        const d = e.currentTarget.duration;
                        setTrimDuration(d);
                        setTrimCurrentTime(0);
                      }}
                      onTimeUpdate={(e) => setTrimCurrentTime(e.currentTarget.currentTime)}
                      onPlay={() => setTrimPlaying(true)}
                      onPause={() => setTrimPlaying(false)}
                    />
                  </div>

                  {/* Controls row */}
                  <div className="anim-slide-up flex items-center gap-3 shrink-0" style={{ animationDelay: "40ms" }}>
                    <button
                      type="button"
                      onClick={() => {
                        const v = trimVideoRef.current;
                        if (!v) return;
                        v.paused ? v.play() : v.pause();
                      }}
                      className="w-9 h-9 rounded-xl bg-accent flex items-center justify-center hover:bg-accent/80 transition-colors active:scale-90 shrink-0"
                    >
                      {trimPlaying ? <PiPauseFill className="text-sm" /> : <PiPlayFill className="text-sm" />}
                    </button>
                    <span className="text-sm font-mono tabular-nums">{fmt(trimCurrentTime)}</span>
                    <span className="text-muted-foreground/40 text-sm">/</span>
                    <span className="text-sm font-mono tabular-nums text-muted-foreground">{fmt(trimDuration)}</span>
                    <div className="flex-1" />
                    {(trimSegs.length > 0 || trimPendingIn !== null) && (
                      <button type="button"
                        onClick={() => { setTrimSegs([]); setTrimPendingIn(null); }}
                        className="text-[12px] text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                        Clear all
                      </button>
                    )}
                    <button type="button"
                      onClick={() => { setTrimFile(""); setTrimVideoSrc(""); setTrimSegs([]); setTrimPendingIn(null); setTrimResult(null); }}
                      className="text-muted-foreground/40 hover:text-muted-foreground transition-all duration-150 hover:scale-110 active:scale-90">
                      <PiXCircleFill className="text-lg" />
                    </button>
                  </div>

                  {/* Timeline */}
                  <div className="anim-slide-up shrink-0" style={{ animationDelay: "70ms" }}>
                    <Timeline
                      duration={trimDuration}
                      currentTime={trimCurrentTime}
                      segments={trimSegs}
                      pendingIn={trimPendingIn}
                      videoRef={trimVideoRef}
                    />
                    <div className="flex items-center justify-between mt-1.5 px-0.5">
                      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/40">
                        {trimPendingIn !== null
                          ? <span className="anim-fade text-amber-400/80">[ {fmt(trimPendingIn)} …</span>
                          : trimSegs.length > 0
                            ? `${trimSegs.length} segment${trimSegs.length > 1 ? "s" : ""}`
                            : "press I to mark in"
                        }
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-muted-foreground/40">
                        {trimTotalLen > 0 ? fmt(trimTotalLen) : ""}
                      </span>
                    </div>
                  </div>

                  {/* Set In / Set Out */}
                  <div className="anim-slide-up flex gap-3 shrink-0" style={{ animationDelay: "100ms" }}>
                    <button type="button" onClick={markIn}
                      className={cn(
                        "flex-1 h-10 flex items-center justify-center gap-2 rounded-xl border text-sm font-medium transition-all duration-150 active:scale-[0.97]",
                        trimPendingIn !== null
                          ? "border-amber-500/40 bg-amber-500/8 text-amber-400"
                          : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                      )}>
                      <span className="font-mono font-bold opacity-50 text-base leading-none">[</span>
                      <span>Set In</span>
                      <kbd className="text-[10px] font-mono opacity-35">I</kbd>
                    </button>
                    <button type="button" onClick={markOut} disabled={trimPendingIn === null}
                      className={cn(
                        "flex-1 h-10 flex items-center justify-center gap-2 rounded-xl border text-sm font-medium transition-all duration-150 active:scale-[0.97]",
                        trimPendingIn !== null
                          ? "border-border text-foreground hover:bg-accent/40 cursor-pointer"
                          : "border-border/40 text-muted-foreground/30 cursor-not-allowed"
                      )}>
                      <span>Set Out</span>
                      <kbd className="text-[10px] font-mono opacity-35">O</kbd>
                      <span className="font-mono font-bold opacity-50 text-base leading-none">]</span>
                    </button>
                  </div>

                  {/* Segment list — capped so video doesn't shrink too much */}
                  {trimSegs.length > 0 && (
                    <div className="anim-slide-up shrink-0 space-y-1 max-h-[120px] overflow-y-auto" style={{ animationDelay: "120ms" }}>
                      {trimSegs.map((seg, i) => (
                        <div key={seg.id}
                          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 transition-colors group">
                          <span className="text-[10px] font-semibold text-muted-foreground/35 w-3 shrink-0 tabular-nums">{i + 1}</span>
                          <span className="font-mono text-[12px] flex-1 tabular-nums">
                            {fmt(seg.inPoint)}
                            <span className="text-muted-foreground/35 mx-1.5">→</span>
                            {fmt(seg.outPoint)}
                          </span>
                          <span className="text-[11px] font-mono tabular-nums text-muted-foreground/35 shrink-0">{fmt(seg.outPoint - seg.inPoint)}</span>
                          <button type="button"
                            onClick={() => setTrimSegs(prev => prev.filter(s => s.id !== seg.id))}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all duration-150 ml-1 shrink-0">
                            <PiXCircleFill className="text-sm" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Export — pinned at bottom */}
                  <div className="shrink-0 space-y-3 pt-1">
                    <div className="border-t border-border" />
                    <button type="button" onClick={exportClip} disabled={!canExport}
                      className={cn("w-full h-11 rounded-xl text-sm font-semibold transition-all duration-200",
                        canExport
                          ? "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.98] hover:scale-[1.005]"
                          : "bg-accent/40 text-muted-foreground cursor-not-allowed")}>
                      {trimProcessing
                        ? <span className="flex items-center justify-center gap-2"><PiSpinnerGapBold className="animate-spin" />Exporting…</span>
                        : trimSegs.length > 1
                          ? `Merge & Export (${trimSegs.length} segments)`
                          : "Export Clip"}
                    </button>
                    {trimResult && <ResultBanner result={trimResult} />}
                  </div>

                </div>
              </main>
            )}
          </>
        )}

        {/* ─ Render ─ */}
        {view === "render" && (
          <>
            <Header icon={<PiFilmReelDuotone />} title="Smoothie" sub="Frame Blending" />

            {/* Empty state */}
            {!renderFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-8">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickRenderVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {/* Loaded state */}
            {!!renderFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-8 gap-8">

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-4 px-5 py-4 rounded-2xl border border-border bg-accent/10 transition-colors hover:bg-accent/15">
                    <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center shrink-0">
                      <PiFilmSlateDuotone className="text-xl text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-semibold truncate">{renderFileName}</p>
                      <div className="mt-0.5 text-sm text-muted-foreground h-5 flex items-center">
                        {renderDetecting && (
                          <span className="anim-fade flex items-center gap-1.5">
                            <PiSpinnerGapBold className="animate-spin" />Detecting FPS…
                          </span>
                        )}
                        {!renderDetecting && renderInputFps !== null && (
                          <span className="anim-fade">
                            Source: <span className="text-foreground font-semibold">{Math.round(renderInputFps)} fps</span>
                          </span>
                        )}
                        {!renderDetecting && renderInputFps === null && (
                          <span className="anim-fade text-destructive">FPS detection failed</span>
                        )}
                      </div>
                    </div>
                    <button type="button"
                      onClick={() => { setRenderFile(""); setRenderInputFps(null); setRenderResult(null); }}
                      className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-all duration-150 hover:scale-110 active:scale-90">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  {/* ── Blur Amount ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "40ms" }}>
                    <div className="flex items-baseline justify-between">
                      <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Blur Amount</p>
                      <p className="text-[12px] text-muted-foreground/50 tabular-nums">
                        {renderFramesBlended} frame{renderFramesBlended !== 1 ? "s" : ""} blended
                        {renderInputFps !== null && ` · ${Math.round(renderInputFps)}fps in → ${renderOutputFps}fps out`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {[
                        { label: "25%", v: 0.25 },
                        { label: "50%", v: 0.5 },
                        { label: "75%", v: 0.75 },
                        { label: "100%", v: 1.0 },
                        { label: "150%", v: 1.5 },
                        { label: "200%", v: 2.0 },
                      ].map(({ label, v }) => (
                        <button key={v} type="button" onClick={() => setBlurAmount(v)}
                          className={cn(
                            "flex-1 h-10 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                            blurAmount === v
                              ? "bg-foreground text-background border-foreground"
                              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                          )}>
                          {label}
                        </button>
                      ))}
                      <div className="flex items-center gap-1">
                        <input
                          type="number" min="0.01" max="3" step="0.05"
                          value={blurAmount}
                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0 && v <= 3) setBlurAmount(v); }}
                          className="w-14 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-border rounded-xl outline-none focus:border-ring tabular-nums"
                        />
                      </div>
                    </div>
                  </div>

                  {/* ── Output FPS ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "70ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Output FPS</p>
                    <div className="flex items-center gap-2">
                      {[30, 60, 120].map((fps) => (
                        <button key={fps} type="button" onClick={() => setRenderOutputFps(fps)}
                          className={cn(
                            "flex-1 h-10 rounded-xl border text-sm font-semibold transition-all duration-200 active:scale-[0.97]",
                            renderOutputFps === fps
                              ? "bg-foreground text-background border-foreground"
                              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                          )}>
                          {fps}
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="1" max="960"
                          value={renderOutputFps}
                          onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) setRenderOutputFps(v); }}
                          className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-border rounded-xl outline-none focus:border-ring tabular-nums"
                        />
                        <span className="text-[12px] text-muted-foreground/40">fps</span>
                      </div>
                    </div>
                  </div>

                  {/* ── Weighting ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "100ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Weighting</p>
                    <div className="flex gap-2">
                      {[
                        { id: "equal", label: "Equal", hint: "uniform" },
                        { id: "gaussian", label: "Gaussian", hint: "bell curve" },
                        { id: "pyramid", label: "Pyramid", hint: "triangle" },
                        { id: "vegas", label: "Vegas", hint: "ascending" },
                        { id: "custom", label: "Custom", hint: "manual" },
                      ].map(({ id, label, hint }) => (
                        <button key={id} type="button" onClick={() => setBlendWeighting(id)}
                          className={cn(
                            "flex-1 h-14 rounded-xl border font-medium flex flex-col items-center justify-center gap-0.5 transition-all duration-200 active:scale-[0.97]",
                            blendWeighting === id
                              ? "bg-foreground text-background border-foreground scale-[1.02]"
                              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                          )}>
                          <span className="text-[11px] font-semibold leading-none">{label}</span>
                          <span className={cn("text-[9px] font-normal mt-0.5", blendWeighting === id ? "opacity-60" : "opacity-35")}>{hint}</span>
                        </button>
                      ))}
                    </div>
                    {blendWeighting === "custom" && (
                      <div className="anim-slide-down space-y-1.5">
                        <input
                          type="text"
                          value={customWeights}
                          onChange={e => setCustomWeights(e.target.value)}
                          placeholder="e.g.  1 2 4 8 4 2 1"
                          spellCheck={false}
                          className="w-full h-9 px-3 font-mono text-[13px] bg-transparent border border-border rounded-xl outline-none placeholder:text-muted-foreground/25 focus:border-ring"
                        />
                        <p className="text-[11px] text-muted-foreground/35">Space-separated weights — one per blended frame</p>
                      </div>
                    )}
                  </div>

                  {/* ── Interpolation ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "130ms" }}>
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Interpolation</p>
                      <p className="text-[11px] text-muted-foreground/35">slow — CPU intensive</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => setInterpolateOn(false)}
                        className={cn("h-10 px-5 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                          !interpolateOn ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40")}>
                        Off
                      </button>
                      <button type="button" onClick={() => setInterpolateOn(true)}
                        className={cn("h-10 px-5 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                          interpolateOn ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40")}>
                        On
                      </button>
                      {interpolateOn && (
                        <div className="anim-fade ml-2 flex items-center gap-2 flex-1">
                          {[360, 480, 960].map(fps => (
                            <button key={fps} type="button" onClick={() => setInterpolateFpsValue(fps)}
                              className={cn("h-10 px-3 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                                interpolateFpsValue === fps
                                  ? "bg-foreground text-background border-foreground"
                                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40")}>
                              {fps}
                            </button>
                          ))}
                          <div className="ml-auto flex items-center gap-1.5">
                            <input
                              type="number" min="1" max="9999"
                              value={interpolateFpsValue}
                              onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) setInterpolateFpsValue(v); }}
                              className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-border rounded-xl outline-none focus:border-ring tabular-nums"
                            />
                            <span className="text-[12px] text-muted-foreground/40">fps</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Timescale ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "160ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Timescale</p>
                    <div className="flex items-center gap-2">
                      {[0.25, 0.5, 1, 2].map((ts) => (
                        <button key={ts} type="button" onClick={() => setRenderTimescale(ts)}
                          className={cn(
                            "flex-1 h-10 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                            renderTimescale === ts
                              ? "bg-foreground text-background border-foreground"
                              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                          )}>
                          {ts}×
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="0.05" max="10" step="0.05"
                          value={renderTimescale}
                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setRenderTimescale(v); }}
                          className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-border rounded-xl outline-none focus:border-ring tabular-nums"
                        />
                        <span className="text-[12px] text-muted-foreground/40">×</span>
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground/35">
                      {renderTimescale === 1 ? "Normal speed" : renderTimescale < 1 ? `Slow to ${Math.round(renderTimescale * 100)}%` : `Speed up ${renderTimescale}×`}
                    </p>
                  </div>

                  {/* Output quality + encoder */}
                  <div className="anim-slide-up space-y-4" style={{ animationDelay: "200ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">Output</p>
                    <div className="grid grid-cols-2 gap-3">
                      {/* Quality */}
                      <div className="space-y-2">
                        <p className="text-[10px] text-muted-foreground/35 uppercase tracking-wider font-medium">Quality</p>
                        <div className="flex gap-2">
                          {[
                            { label: "High", crf: 17 },
                            { label: "Med", crf: 22 },
                            { label: "Low", crf: 28 },
                          ].map(({ label, crf }) => (
                            <button key={crf} type="button" onClick={() => setRenderCrf(crf)}
                              className={cn(
                                "flex-1 h-10 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                                renderCrf === crf
                                  ? "bg-foreground text-background border-foreground"
                                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                              )}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* Encoder */}
                      <div className="space-y-2">
                        <p className="text-[10px] text-muted-foreground/35 uppercase tracking-wider font-medium">Encoder</p>
                        <div className="flex gap-2">
                          {[
                            { label: "CPU", id: "libx264" },
                            { label: "GPU", id: "h264_nvenc" },
                          ].map(({ label, id }) => (
                            <button key={id} type="button" onClick={() => setRenderEncoder(id)}
                              className={cn(
                                "flex-1 h-10 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-[0.97]",
                                renderEncoder === id
                                  ? "bg-foreground text-background border-foreground"
                                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                              )}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground/35">
                      CRF {renderCrf} · {renderEncoder === "h264_nvenc" ? "NVENC — requires NVIDIA GPU" : "libx264"}
                    </p>
                  </div>

                  <div className="flex-1" />

                  {/* Render */}
                  <div className="anim-fade space-y-4" style={{ animationDelay: "200ms" }}>
                    <div className="border-t border-border" />
                    {renderProcessing ? (
                      <div className="space-y-3">
                        {renderFile && (
                          <div className="rounded-xl overflow-hidden border border-border bg-black/50">
                            <video
                              src={convertFileSrc(renderFile)}
                              controls
                              muted
                              autoPlay
                              loop
                              className="w-full max-h-[180px]"
                              preload="metadata"
                            />
                          </div>
                        )}
                        <div className="h-1.5 w-full rounded-full bg-accent/40 overflow-hidden">
                          <div
                            className="h-full bg-foreground rounded-full transition-[width] duration-300 ease-out"
                            style={{ width: `${Math.round((renderProgress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-muted-foreground tabular-nums">
                          <span>{Math.round((renderProgress ?? 0) * 100)}%</span>
                          <span className="text-[11px] opacity-60">{renderEncoder === "h264_nvenc" ? "NVENC" : "libx264"}</span>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={processRender} disabled={!canRender}
                        className={cn("w-full h-11 rounded-xl text-sm font-semibold transition-all duration-200",
                          canRender
                            ? "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.98] hover:scale-[1.005]"
                            : "bg-accent/40 text-muted-foreground cursor-not-allowed")}>
                        Render
                      </button>
                    )}
                    {renderResult && <ResultBanner result={renderResult} />}
                  </div>

                </div>
              </main>
            )}
          </>
        )}

        {/* ─ Settings ─ */}
        {view === "settings" && (
          <>
            <Header icon={<PiGearSixDuotone />} title="Settings" />
            <main className="flex-1 overflow-auto">
              <div className="min-h-full flex flex-col p-8 gap-8">

                {/* FFmpeg */}
                <div className="anim-slide-up">
                  <p className="text-[13px] font-semibold mb-1">FFmpeg Executable</p>
                  <p className="text-[13px] text-muted-foreground mb-4">Required for all video processing and FPS detection.</p>
                  <div className="flex gap-2 items-center">
                    <input type="text" value={ffmpegPath} onChange={e => saveFfmpegPath(e.target.value)}
                      placeholder="C:\path\to\ffmpeg.exe" spellCheck={false}
                      className={cn("flex-1 h-9 px-3 font-mono text-[13px] bg-transparent border rounded-lg outline-none placeholder:text-muted-foreground/30 transition-colors duration-150 focus:border-ring",
                        ffmpegValid === false ? "border-destructive/50" : "border-border")} />
                    <button type="button" onClick={pickFfmpeg}
                      className="h-9 px-3 text-sm border border-border rounded-lg shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/40 flex items-center gap-1.5 transition-all duration-150 active:scale-[0.97]">
                      <PiFolderOpenDuotone className="text-base" />Browse
                    </button>
                    {ffmpegValid === true && <PiCheckCircleFill className="anim-pop text-emerald-500 text-xl shrink-0" />}
                    {ffmpegValid === false && <PiXCircleFill className="anim-scale-in text-destructive text-xl shrink-0" />}
                  </div>
                  {ffmpegValid === false && (
                    <p className="anim-slide-down text-[12px] text-destructive mt-2">Not a valid ffmpeg executable.</p>
                  )}
                </div>

                {/* Divider */}
                <div className="border-t border-border" />

                {/* Updates */}
                <div className="anim-slide-up space-y-4" style={{ animationDelay: "40ms" }}>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-semibold">Updates</p>
                    <span className="text-[11px] text-muted-foreground/40 font-mono">v0.1.0</span>
                  </div>

                  {/* Status card */}
                  {updateStatus === "checking" && (
                    <div className="anim-fade flex items-center gap-2.5 px-4 py-3 rounded-xl border border-border bg-accent/5">
                      <PiSpinnerGapBold className="animate-spin text-muted-foreground shrink-0" />
                      <span className="text-[13px] text-muted-foreground">Checking for updates…</span>
                    </div>
                  )}

                  {updateStatus === "uptodate" && (
                    <div className="anim-fade flex items-center gap-2.5 px-4 py-3 rounded-xl border border-border bg-accent/5">
                      <PiCheckCircleFill className="text-emerald-500 shrink-0" />
                      <span className="text-[13px] text-muted-foreground">You're on the latest version.</span>
                    </div>
                  )}

                  {updateStatus === "available" && updateInfo && (
                    <div className="anim-slide-down rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 space-y-3">
                      <div className="flex items-start gap-2.5">
                        <PiDownloadSimpleDuotone className="text-emerald-400 text-lg shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold text-emerald-400">v{updateInfo.version} available</p>
                          {updateInfo.body && (
                            <p className="text-[12px] text-muted-foreground/60 mt-0.5 leading-relaxed">{updateInfo.body}</p>
                          )}
                        </div>
                      </div>
                      <button type="button" onClick={doInstallUpdate}
                        className="w-full h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[13px] font-medium hover:bg-emerald-500/25 transition-all duration-150 active:scale-[0.98]">
                        Download &amp; Install
                      </button>
                    </div>
                  )}

                  {updateStatus === "downloading" && (
                    <div className="anim-fade rounded-xl border border-border bg-accent/5 px-4 py-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] text-muted-foreground">Downloading update…</span>
                        <span className="text-[12px] font-mono text-muted-foreground/50 tabular-nums">{updateProgress}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-accent/40 overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-[width] duration-300 ease-out"
                          style={{ width: `${updateProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {updateStatus === "ready" && (
                    <div className="anim-slide-down rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 space-y-3">
                      <div className="flex items-center gap-2.5">
                        <PiCheckCircleFill className="text-emerald-400 shrink-0" />
                        <p className="text-[13px] text-emerald-400 font-medium">Update installed. Restart to apply.</p>
                      </div>
                      <button type="button" onClick={() => relaunch()}
                        className="w-full h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[13px] font-medium hover:bg-emerald-500/25 flex items-center justify-center gap-2 transition-all duration-150 active:scale-[0.98]">
                        <PiArrowCounterClockwiseDuotone className="text-base" />
                        Restart now
                      </button>
                    </div>
                  )}

                  {updateStatus === "error" && (
                    <div className="anim-fade rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3">
                      <p className="text-[13px] text-destructive/80">{updateError || "Update check failed."}</p>
                    </div>
                  )}

                  {/* Manual check button — shown when not actively busy */}
                  {(updateStatus === "idle" || updateStatus === "uptodate" || updateStatus === "error") && (
                    <button type="button" onClick={doCheckUpdate}
                      className="h-9 px-4 text-[13px] border border-border rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/40 flex items-center gap-1.5 transition-all duration-150 active:scale-[0.97]">
                      <PiArrowsClockwiseDuotone className="text-base" />
                      Check for updates
                    </button>
                  )}
                </div>

              </div>
            </main>
          </>
        )}

      </div>

      {/* ── Export success modal ── */}
      {successModal && (
        <ExportSuccessModal
          data={successModal}
          onClose={() => setSuccessModal(null)}
          onReveal={() => { revealInExplorer(successModal.outputPath); setSuccessModal(null); }}
        />
      )}
    </div>
  );
}

// ── FFmpeg warning banner ──
function FfmpegWarning({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="anim-slide-down shrink-0 w-full flex items-center gap-2.5 px-4 py-3 rounded-xl border border-border text-left group transition-all duration-150 hover:bg-accent/30 active:scale-[0.99]">
      <PiWarningCircleDuotone className="text-base text-muted-foreground shrink-0" />
      <span className="text-[13px] text-muted-foreground">
        FFmpeg not configured —{" "}
        <span className="text-foreground group-hover:underline underline-offset-2">open Settings</span>
      </span>
    </button>
  );
}

// ── Result banner ──
function ResultBanner({ result }: { result: ProcessResult }) {
  return (
    <div className={cn("anim-slide-up rounded-xl border px-4 py-3 text-[13px]",
      result.success
        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-400"
        : "border-destructive/20 bg-destructive/5 text-destructive")}>
      <p className="font-medium">{result.message}</p>
      {result.output_path && (
        <p className="mt-1 font-mono text-[11px] opacity-60 break-all">{result.output_path}</p>
      )}
    </div>
  );
}

// ── Export success modal ──
function ExportSuccessModal({ data, onClose, onReveal }: {
  data: { message: string; outputPath: string };
  onClose: () => void;
  onReveal: () => void;
}) {
  const fileName = data.outputPath.split(/[\\/]/).pop() ?? data.outputPath;
  const isVideo = /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(data.outputPath);
  const videoSrc = isVideo ? convertFileSrc(data.outputPath) : null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[3px] anim-fade"
      onClick={onClose}
    >
      <div
        className="anim-scale-in bg-card border border-border rounded-2xl p-6 w-[420px] shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
            <PiCheckCircleFill className="text-emerald-400 text-lg" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-sm font-semibold">{data.message}</p>
            <p className="text-[11px] font-mono text-muted-foreground/50 mt-1.5 truncate" title={data.outputPath}>
              {fileName}
            </p>
          </div>
        </div>

        {videoSrc && (
          <div className="rounded-xl overflow-hidden border border-border bg-black/50">
            <video
              src={videoSrc}
              controls
              className="w-full max-h-[280px]"
              preload="metadata"
            />
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReveal}
            className="flex-1 h-9 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-all duration-150 active:scale-[0.98]"
          >
            Open Location
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-9 rounded-lg bg-foreground text-background text-sm font-semibold hover:bg-foreground/90 transition-all duration-150 active:scale-[0.98]"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Drop zone — flex-1 so it fills its parent ──
function DropZone({ isDragOver, onClick, label, hint }: {
  isDragOver: boolean; onClick: () => void; label: string; hint: string;
}) {
  return (
    <div onClick={onClick} className={cn(
      "anim-scale-in flex-1 w-full rounded-2xl border-2 border-dashed cursor-pointer min-h-[200px]",
      "flex flex-col items-center justify-center gap-5 transition-all duration-200",
      isDragOver
        ? "border-foreground/25 bg-accent/25 scale-[1.015] shadow-[0_0_40px_rgba(255,255,255,0.04)]"
        : "border-border hover:border-border/70 hover:bg-accent/10 hover:scale-[1.005]"
    )}>
      <div className={cn(
        "w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-200",
        isDragOver ? "bg-accent scale-110" : "bg-accent/50"
      )}>
        <PiFilmSlateDuotone className={cn("text-2xl transition-colors duration-200",
          isDragOver ? "text-foreground/70" : "text-muted-foreground")} />
      </div>
      <div className="text-center space-y-1.5">
        <p className="text-base font-medium">{isDragOver ? "Release to load" : label}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

// ── Multi-segment timeline with smooth drag ──
function Timeline({ duration, currentTime, segments, pendingIn, videoRef }: {
  duration: number;
  currentTime: number;
  segments: Seg[];
  pendingIn: number | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  // Keep duration fresh inside the effect closure without re-registering listeners
  const vals = useRef(duration);
  vals.current = duration;

  useEffect(() => {
    const seek = (clientX: number) => {
      if (!barRef.current || vals.current <= 0) return;
      const rect = barRef.current.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * vals.current;
      if (videoRef.current) videoRef.current.currentTime = t;
    };
    const onMove = (e: MouseEvent) => { if (isDragging.current) seek(e.clientX); };
    const onUp = () => { isDragging.current = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [videoRef]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    isDragging.current = true;
    if (!barRef.current || vals.current <= 0) return;
    const rect = barRef.current.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * vals.current;
    if (videoRef.current) videoRef.current.currentTime = t;
  };

  const pct = (t: number) => duration > 0 ? `${(t / duration) * 100}%` : "0%";

  return (
    <div
      ref={barRef}
      onMouseDown={onMouseDown}
      className="relative h-11 rounded-xl overflow-visible cursor-pointer"
      style={{ userSelect: "none" }}
    >
      <div className="absolute inset-0 rounded-xl bg-accent/20" />

      {segments.map((seg) => {
        const inPct = duration > 0 ? (seg.inPoint / duration) * 100 : 0;
        const outPct = duration > 0 ? (seg.outPoint / duration) * 100 : 100;
        return (
          <div key={seg.id}
            className="absolute inset-y-0 bg-foreground/12 border-x-2 border-foreground/25 rounded-sm"
            style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }}
          />
        );
      })}

      {pendingIn !== null && (
        <div className="absolute inset-y-0 w-0.5 bg-amber-400/80 pointer-events-none"
          style={{ left: pct(pendingIn) }}>
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0"
            style={{ borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderTop: "5px solid rgba(251,191,36,0.8)" }} />
        </div>
      )}

      {/* Playhead — slightly wider grab target */}
      <div className="absolute inset-y-0 flex items-center justify-center pointer-events-none"
        style={{ left: pct(currentTime), transform: "translateX(-50%)", width: "12px" }}>
        <div className="w-px h-full bg-foreground/60" />
        <div className="absolute top-0 w-2.5 h-2.5 rounded-full bg-foreground border-2 border-background"
          style={{ transform: "translateY(-30%)" }} />
      </div>
    </div>
  );
}

function Header({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <header className="h-12 px-6 flex items-center gap-2 border-b border-border shrink-0">
      <span className="text-muted-foreground text-sm">{icon}</span>
      <span className="text-sm font-medium">{title}</span>
      {sub && (
        <>
          <span className="text-muted-foreground/30 text-sm">/</span>
          <span className="text-sm text-muted-foreground">{sub}</span>
        </>
      )}
    </header>
  );
}

function SidebarItem({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick}
      className={cn("w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all duration-150 active:scale-[0.98]",
        active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent/40")}>
      <span className={cn("text-base shrink-0 transition-transform duration-200", active ? "scale-110" : "")}>{icon}</span>
      {children}
    </button>
  );
}
