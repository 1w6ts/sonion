import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { cn } from "@/lib/utils";
import { SiDiscord } from "react-icons/si";
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

interface ProcessResult { success: boolean; message: string; output_path?: string; }
interface Seg { id: string; inPoint: number; outPoint: number; }
type View = "clean" | "trim" | "render" | "discord" | "settings";

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];

const VIEW_META: Record<View, { title: string; sub?: string; icon: React.ReactNode }> = {
  discord: { title: "Discord Compress", sub: "8 MB Target", icon: <SiDiscord /> },
  clean: { title: "TikTok Optimizer", sub: "Metadata Patch", icon: <PiSparkleDuotone /> },
  trim: { title: "Trim", sub: "Lossless Cut", icon: <PiScissorsDuotone /> },
  render: { title: "Motion Blur", sub: "Frame Blending", icon: <PiFilmReelDuotone /> },
  settings: { title: "Settings", icon: <PiGearSixDuotone /> },
};

const fmt = (t: number) => {
  if (!isFinite(t) || isNaN(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
};

export default function App() {
  const [view, setView] = useState<View>("discord");
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffmpegValid, setFfmpegValid] = useState<boolean | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── Updater state ──
  type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "uptodate" | "error";
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string | null } | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState("");
  const pendingUpdate = useRef<Update | null>(null);

  const navigate = (nextView: View) => {
    if (nextView === view) return;
    setView(nextView);
  };

  // ── Clean state ──
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

  // ── Discord state ──
  const [discordFile, setDiscordFile] = useState("");
  const [discordProcessing, setDiscordProcessing] = useState(false);
  const [discordProgress, setDiscordProgress] = useState<number | null>(null);
  const [discordResult, setDiscordResult] = useState<ProcessResult | null>(null);

  // ── Motion Blur state ──
  const [renderFile, setRenderFile] = useState("");
  const [renderInputFps, setRenderInputFps] = useState<number | null>(null);
  const [renderDetecting, setRenderDetecting] = useState(false);
  const [renderProcessing, setRenderProcessing] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderResult, setRenderResult] = useState<ProcessResult | null>(null);
  const [motionRuntimeInstalled, setMotionRuntimeInstalled] = useState<boolean | null>(null);
  const [motionRuntimeInstalling, setMotionRuntimeInstalling] = useState(false);
  const [motionRuntimeProgress, setMotionRuntimeProgress] = useState<number | null>(null);

  // Persistent Motion Blur settings
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
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
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

  useEffect(() => {
    if (view !== "render") return;
    invoke<boolean>("check_motion_runtime")
      .then(setMotionRuntimeInstalled)
      .catch(() => setMotionRuntimeInstalled(false));
  }, [view]);

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
      const res = await invoke<ProcessResult>("patch_tiktok_optimizer", { inputPath: cleanFile });
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

  const installMotionRuntime = async () => {
    setMotionRuntimeInstalling(true);
    setMotionRuntimeProgress(0);
    const unlisten = await listen<number>("motion-runtime-progress", (e) => {
      setMotionRuntimeProgress(e.payload);
    });
    try {
      const res = await invoke<ProcessResult>("install_motion_runtime");
      if (res.success) {
        const ok = await invoke<boolean>("check_motion_runtime");
        setMotionRuntimeInstalled(ok);
        if (!ok) {
          setRenderResult({ success: false, message: "Install reported success but runtime files are missing." });
        }
      } else {
        setRenderResult({ success: false, message: res.message });
      }
    } catch (e) {
      setRenderResult({ success: false, message: `Install failed: ${e}` });
    } finally {
      unlisten();
      setMotionRuntimeInstalling(false);
      setMotionRuntimeProgress(null);
    }
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
      const res = await invoke<ProcessResult>("render_video_motion_runtime", {
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

  const handleDiscordFile = (path: string) => {
    setDiscordFile(path);
    setDiscordResult(null);
    setDiscordProgress(null);
  };

  const pickDiscordVideo = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: VIDEO_EXTS }] });
      if (typeof sel === "string") handleDiscordFile(sel);
    } catch (e) { console.error(e); }
  };

  const compressForDiscord = async () => {
    if (!ffmpegPath || !discordFile) return;
    setDiscordProcessing(true);
    setDiscordResult(null);
    setDiscordProgress(0);
    const unlisten = await listen<number>("discord-progress", (e) => {
      setDiscordProgress(e.payload);
    });
    try {
      const res = await invoke<ProcessResult>("compress_for_discord", {
        ffmpegPath,
        inputPath: discordFile,
      });
      if (res.success && res.output_path) {
        setSuccessModal({ message: res.message, outputPath: res.output_path });
      } else {
        setDiscordResult(res);
      }
    } catch (e) {
      setDiscordResult({ success: false, message: `Error: ${e}` });
    } finally {
      unlisten();
      setDiscordProcessing(false);
      setDiscordProgress(null);
    }
  };

  if (view === "trim") {
    handleFileRef.current = handleTrimFile;
  } else if (view === "render") {
    handleFileRef.current = handleRenderFile;
  } else if (view === "clean") {
    handleFileRef.current = handleCleanFile;
  } else if (view === "discord") {
    handleFileRef.current = handleDiscordFile;
  } else {
    handleFileRef.current = handleDiscordFile;
  }

  const [successModal, setSuccessModal] = useState<{ message: string; outputPath: string } | null>(null);

  const revealInExplorer = async (path: string) => {
    try { await invoke("reveal_in_explorer", { path }); } catch (e) { console.error(e); }
  };

  const canExport = !!ffmpegValid && trimSegs.length > 0 && !trimProcessing;
  const canRender = !!ffmpegValid && !!renderFile && renderInputFps !== null && !renderProcessing && motionRuntimeInstalled === true;
  const canClean = !!cleanFile && !cleanProcessing;
  const canDiscord = !!ffmpegValid && !!discordFile && !discordProcessing;
  const cleanFileName = cleanFile.split(/[\\/]/).pop() ?? "";
  const renderFileName = renderFile.split(/[\\/]/).pop() ?? "";
  const discordFileName = discordFile.split(/[\\/]/).pop() ?? "";
  const trimTotalLen = trimSegs.reduce((acc, s) => acc + (s.outPoint - s.inPoint), 0);
  const renderWorkingFps = interpolateOn && interpolateFpsValue > 0 ? interpolateFpsValue : (renderInputFps ?? renderOutputFps);
  const renderFramesBlended = Math.max(1, Math.round(renderWorkingFps / renderOutputFps * blurAmount));

  return (
    <div className="flex h-screen bg-background text-foreground font-sans antialiased select-none overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className={cn(
        "shrink-0 flex flex-col border-r border-border bg-sidebar transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]",
        sidebarCollapsed ? "w-[56px]" : "w-56"
      )}>
        <div className={cn("h-14 flex items-center border-b border-border transition-[padding] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]", sidebarCollapsed ? "px-4 justify-center" : "px-3.5 gap-2.5")}>
          <img src="/logo.png" alt="xype" className="w-6 h-6 shrink-0" />
          <div className={cn("min-w-0 transition-opacity duration-150", sidebarCollapsed ? "hidden opacity-0" : "block opacity-100")}>
            <span className="block text-[13px] font-semibold tracking-tight leading-none">xype</span>
            <span className="block mt-1 text-[11px] text-muted-foreground">video tools</span>
          </div>
          {!sidebarCollapsed && (
            <button type="button" onClick={() => setSidebarCollapsed(true)}
              className="motion-press ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/55"
              aria-label="Collapse sidebar">
              <span className="text-base leading-none">‹</span>
            </button>
          )}
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {!sidebarCollapsed && <p className="px-2.5 pt-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/50">Modules</p>}
          {sidebarCollapsed && (
            <button type="button" onClick={() => setSidebarCollapsed(false)}
              className="motion-press mb-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/55"
              aria-label="Expand sidebar">
              <span className="text-base leading-none">›</span>
            </button>
          )}
          <SidebarItem collapsed={sidebarCollapsed} active={view === "discord"} onClick={() => navigate("discord")} icon={<SiDiscord />}>
            Discord Compress
          </SidebarItem>
          <SidebarItem collapsed={sidebarCollapsed} active={view === "clean"} onClick={() => navigate("clean")} icon={<PiSparkleDuotone />}>
            TikTok Optimizer
          </SidebarItem>
          <SidebarItem collapsed={sidebarCollapsed} active={view === "trim"} onClick={() => navigate("trim")} icon={<PiScissorsDuotone />}>
            Trim
          </SidebarItem>
          <SidebarItem collapsed={sidebarCollapsed} active={false} disabled tooltip="Motion Blur is unavailable right now" onClick={() => { }} icon={<PiFilmReelDuotone />}>
            Motion Blur
          </SidebarItem>
        </nav>

        <div className="p-2 border-t border-border">
          <SidebarItem collapsed={sidebarCollapsed} active={view === "settings"} onClick={() => navigate("settings")} icon={<PiGearSixDuotone />}>
            Settings
            <span className={cn("ml-auto flex items-center gap-1", sidebarCollapsed && "hidden")}>
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
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ─ Clean ─ */}
        {view === "clean" && (
          <>
            <Header {...VIEW_META.clean} />

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
                  <div className="anim-slide-up flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-card/35 transition-colors hover:bg-card/55">
                    <div className="w-9 h-9 rounded-md bg-accent flex items-center justify-center shrink-0">
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
                  <div className="anim-slide-up rounded-lg border border-border bg-card/25 px-4 py-3 space-y-1.5" style={{ animationDelay: "40ms" }}>
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
            <Header {...VIEW_META.trim} />

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
                  <div className="anim-scale-in flex-1 min-h-[120px] rounded-lg overflow-hidden bg-black border border-border">
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
            <Header {...VIEW_META.render} />

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

                  {/* Motion runtime install card */}
                  {motionRuntimeInstalled === false && (
                    <div className="anim-slide-up rounded-xl border border-border bg-accent/5 px-4 py-4 space-y-3">
                      <div className="flex items-start gap-2.5">
                        <PiDownloadSimpleDuotone className="text-emerald-400 text-lg shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold text-foreground">Motion engine not installed</p>
                          <p className="text-[12px] text-muted-foreground/60 mt-0.5 leading-relaxed">
                            The high-quality motion blur engine uses VapourSynth plugins (~40 MB). Click below to install automatically.
                          </p>
                        </div>
                      </div>
                      {motionRuntimeInstalling ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] text-muted-foreground">Downloading motion engine…</span>
                            <span className="text-[12px] font-mono text-muted-foreground/50 tabular-nums">{motionRuntimeProgress ?? 0}%</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-accent/40 overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-[width] duration-300 ease-out"
                              style={{ width: `${motionRuntimeProgress ?? 0}%` }} />
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={installMotionRuntime}
                          className="motion-press w-full h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[13px] font-medium hover:bg-emerald-500/25 flex items-center justify-center gap-2">
                          <PiDownloadSimpleDuotone className="text-base" />
                          Install motion engine
                        </button>
                      )}
                    </div>
                  )}

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-card/35 transition-colors hover:bg-card/55">
                    <div className="w-9 h-9 rounded-md bg-accent flex items-center justify-center shrink-0">
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
                          <div className="rounded-lg overflow-hidden border border-border bg-black/50">
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

        {/* ─ Discord ─ */}
        {view === "discord" && (
          <>
            <Header {...VIEW_META.discord} />

            {!discordFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-8">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickDiscordVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {!!discordFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-8 gap-8">

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-card/35 transition-colors hover:bg-card/55">
                    <div className="w-9 h-9 rounded-md bg-accent flex items-center justify-center shrink-0">
                      <PiFilmSlateDuotone className="text-xl text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-semibold truncate">{discordFileName}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">Ready to compress</p>
                    </div>
                    <button type="button"
                      onClick={() => { setDiscordFile(""); setDiscordResult(null); setDiscordProgress(null); }}
                      className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-all duration-150 hover:scale-110 active:scale-90">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  {/* Info card */}
                  <div className="anim-slide-up rounded-lg border border-border bg-card/25 px-4 py-3 space-y-1.5" style={{ animationDelay: "40ms" }}>
                    <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">What happens</p>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      Calculates the exact bitrate needed to fit the video under{" "}
                      <span className="font-semibold text-foreground">8 MB</span>, then re-encodes with{" "}
                      <span className="font-mono text-foreground/80 text-[12px]">libx264</span> using a fast preset.
                      Resolution is scaled down automatically if the bitrate gets too low.
                    </p>
                  </div>

                  <div className="flex-1" />

                  {/* Compress */}
                  <div className="anim-fade space-y-4" style={{ animationDelay: "100ms" }}>
                    <div className="border-t border-border" />
                    {discordProcessing ? (
                      <div className="space-y-3">
                        <div className="h-1.5 w-full rounded-full bg-accent/40 overflow-hidden">
                          <div
                            className="h-full bg-foreground rounded-full transition-[width] duration-300 ease-out"
                            style={{ width: `${Math.round((discordProgress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-muted-foreground tabular-nums">
                          <span>{Math.round((discordProgress ?? 0) * 100)}%</span>
                          <span className="text-[11px] opacity-60">libx264 · veryfast</span>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={compressForDiscord} disabled={!canDiscord}
                        className={cn("w-full h-11 rounded-xl text-sm font-semibold transition-all duration-200",
                          canDiscord
                            ? "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.98] hover:scale-[1.005]"
                            : "bg-accent/40 text-muted-foreground cursor-not-allowed")}>
                        Compress for Discord
                      </button>
                    )}
                    {discordResult && <ResultBanner result={discordResult} />}
                  </div>

                </div>
              </main>
            )}
          </>
        )}

        {/* ─ Settings ─ */}
        {view === "settings" && (
          <>
            <Header {...VIEW_META.settings} />
            <main className="flex-1 overflow-auto">
              <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)_280px] gap-5 p-6">

                <section className="anim-slide-up rounded-lg border border-border bg-card/30">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-[13px] font-medium">FFmpeg executable</p>
                    <p className="mt-1 text-[12px] text-muted-foreground">Used for compression, trimming, rendering, and metadata reads.</p>
                  </div>
                  <div className="p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                      <input type="text" value={ffmpegPath} onChange={e => saveFfmpegPath(e.target.value)}
                        placeholder="C:\path\to\ffmpeg.exe" spellCheck={false}
                        className={cn("h-9 min-w-0 rounded-md border bg-background/40 px-3 font-mono text-[12px] outline-none placeholder:text-muted-foreground/30 transition-colors duration-150 focus:border-ring",
                          ffmpegValid === false ? "border-destructive/50" : "border-border")} />
                      <button type="button" onClick={pickFfmpeg}
                        className="motion-press h-9 px-3 text-[13px] border border-border rounded-md shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5">
                        <PiFolderOpenDuotone className="text-base" />Browse
                      </button>
                      <span className="grid size-9 place-items-center">
                        {ffmpegValid === true && <PiCheckCircleFill className="anim-pop text-emerald-500 text-lg shrink-0" />}
                        {ffmpegValid === false && <PiXCircleFill className="anim-scale-in text-destructive text-lg shrink-0" />}
                      </span>
                    </div>
                    {ffmpegValid === false && (
                      <p className="anim-slide-down text-[12px] text-destructive mt-2">Not a valid ffmpeg executable.</p>
                    )}
                  </div>
                </section>

                <section className="anim-slide-up rounded-lg border border-border bg-card/30 space-y-4 p-4" style={{ animationDelay: "30ms" }}>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium">Updates</p>
                    <span className="text-[11px] text-muted-foreground/50 font-mono">{appVersion ? `v${appVersion}` : ""}</span>
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
                        className="motion-press w-full h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[13px] font-medium hover:bg-emerald-500/25">
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
                        className="motion-press w-full h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[13px] font-medium hover:bg-emerald-500/25 flex items-center justify-center gap-2">
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

                  {(updateStatus === "idle" || updateStatus === "uptodate" || updateStatus === "error") && (
                    <button type="button" onClick={doCheckUpdate}
                      className="motion-press h-9 px-4 text-[13px] border border-border rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/40 flex items-center gap-1.5">
                      <PiArrowsClockwiseDuotone className="text-base" />
                      Check for updates
                    </button>
                  )}
                </section>

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
      className="motion-press anim-slide-down shrink-0 w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border bg-accent/30 text-left group hover:bg-accent/45">
      <span className="text-muted-foreground">
        <PiWarningCircleDuotone className="text-base shrink-0" />
      </span>
      <span className="text-[13px] text-muted-foreground">
        FFmpeg not configured —{" "}
        <span className="text-foreground font-medium group-hover:underline underline-offset-4">open Settings</span>
      </span>
    </button>
  );
}

// ── Result banner ──
function ResultBanner({ result }: { result: ProcessResult }) {
  return (
    <div className={cn("anim-slide-up rounded-lg border px-3 py-2.5 text-[13px]",
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 anim-fade"
      onClick={onClose}
    >
      <div
        className="anim-scale-in bg-card border border-border rounded-xl p-5 w-[420px] shadow-lg space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
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
          <div className="rounded-lg overflow-hidden border border-border bg-black/50">
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
            className="motion-press flex-1 h-9 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50"
          >
            Open Location
          </button>
          <button
            type="button"
            onClick={onClose}
            className="motion-press flex-1 h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90"
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
      "motion-lift anim-scale-in group relative flex-1 w-full rounded-xl border border-dashed cursor-pointer min-h-[220px] overflow-hidden",
      "flex flex-col items-center justify-center gap-4",
      isDragOver
        ? "border-foreground/30 bg-accent/50"
        : "border-border bg-card/25 hover:bg-card/45 hover:border-border/80"
    )}>
      <div className={cn(
        "relative w-11 h-11 rounded-lg flex items-center justify-center motion-smooth transition-colors",
        isDragOver ? "bg-accent text-foreground" : "bg-accent/50 text-muted-foreground group-hover:text-foreground"
      )}>
        <PiFilmSlateDuotone className="text-xl transition-colors duration-150" />
      </div>
      <div className="relative text-center space-y-1">
        <p className="text-[15px] font-medium tracking-tight">{isDragOver ? "Release to load" : label}</p>
        <p className="text-sm text-muted-foreground max-w-[34ch] leading-relaxed">{hint}</p>
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
    <header className="h-14 px-5 flex items-center gap-2.5 border-b border-border shrink-0 bg-background">
      <span className="text-muted-foreground text-base">{icon}</span>
      <span className="text-[13px] font-medium tracking-tight">{title}</span>
      {sub && (
        <>
          <span className="text-muted-foreground/25 text-sm">/</span>
          <span className="text-sm text-muted-foreground">{sub}</span>
        </>
      )}
    </header>
  );
}

function SidebarItem({ active, collapsed = false, disabled = false, tooltip, onClick, icon, children }: {
  active: boolean; collapsed?: boolean; disabled?: boolean; tooltip?: string; onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={disabled ? undefined : onClick} aria-disabled={disabled}
      title={tooltip ?? (collapsed && typeof children === "string" ? children : undefined)}
      className={cn(
        "group relative w-full overflow-hidden rounded-md text-[13px] outline-none transition-colors duration-150",
        collapsed ? "h-9 px-0" : "h-8 px-2.5",
        disabled ? "cursor-not-allowed text-muted-foreground/35" : active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}>
      <span className={cn(
        "absolute inset-0 rounded-md transition-opacity duration-150",
        disabled ? "bg-accent opacity-0" : active ? "bg-accent opacity-100" : "bg-accent opacity-0 group-hover:opacity-55"
      )} />
      <span className={cn(
        "absolute left-0.5 top-1/2 h-4 w-px -translate-y-1/2 rounded-full bg-foreground transition-opacity duration-150",
        active ? "opacity-70" : "opacity-0"
      )} />
      <span className={cn("relative flex h-full items-center", collapsed ? "justify-center" : "gap-2.5")}>
        <span className={cn(
          "grid size-5 place-items-center text-base shrink-0 transition-colors duration-150",
          disabled ? "text-muted-foreground/35" : active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
        )}>{icon}</span>
        {!collapsed && <span className="truncate">{children}</span>}
      </span>
    </button>
  );
}
