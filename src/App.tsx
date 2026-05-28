import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
interface PublicAuthSession { user_id: string; email: string; expires_at: string; }
interface Seg { id: string; inPoint: number; outPoint: number; }
type View = "home" | "clean" | "trim" | "render" | "discord" | "compress" | "settings";
type CompressEncoder = "libx264" | "libx265" | "h264_nvenc";
type CompressResolution = "source" | "1080" | "720" | "480";
type CompressPreset = "medium" | "slow" | "slower";

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];

const VIEW_META: Record<Exclude<View, "home">, { title: string; sub?: string; icon: React.ReactNode }> = {
  discord: { title: "Discord Compress", sub: "8 MB Target", icon: <SiDiscord /> },
  compress: { title: "Quality Compress", sub: "HandBrake-style", icon: <PiFilmSlateDuotone /> },
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
  const [view, setView] = useState<View>("home");
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffmpegValid, setFfmpegValid] = useState<boolean | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [sidebarCollapsed] = useState(false);
  const [authSession, setAuthSession] = useState<PublicAuthSession | null>(null);
  const [appAccess, setAppAccess] = useState<boolean | null>(null);
  const [accessError, setAccessError] = useState<string>("");
  const [discordPresenceEnabled, setDiscordPresenceEnabledState] = useState(() => localStorage.getItem("discordPresence.enabled") !== "false");
  const [discordPresenceStatus, setDiscordPresenceStatus] = useState<"connected" | "off" | "error" | "loading">("loading");

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

  const applyDiscordPresence = async (enabled: boolean) => {
    setDiscordPresenceStatus("loading");
    try {
      await invoke("set_discord_presence_enabled", { enabled });
      setDiscordPresenceStatus(enabled ? "connected" : "off");
    } catch (e) {
      console.warn("Discord Rich Presence failed:", e);
      setDiscordPresenceStatus(enabled ? "error" : "off");
    }
  };

  const setDiscordPresenceEnabled = (enabled: boolean) => {
    setDiscordPresenceEnabledState(enabled);
    localStorage.setItem("discordPresence.enabled", String(enabled));
    void applyDiscordPresence(enabled);
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

  // Quality compressor state
  const [compressFile, setCompressFile] = useState("");
  const [compressProcessing, setCompressProcessing] = useState(false);
  const [compressProgress, setCompressProgress] = useState<number | null>(null);
  const [compressResult, setCompressResult] = useState<ProcessResult | null>(null);
  const [compressEncoder, setCompressEncoderState] = useState<CompressEncoder>(() => (localStorage.getItem("compress.encoder") as CompressEncoder) || "libx264");
  const [compressQuality, setCompressQualityState] = useState(() => Number(localStorage.getItem("compress.quality") ?? "20"));
  const [compressPreset, setCompressPresetState] = useState<CompressPreset>(() => (localStorage.getItem("compress.preset") as CompressPreset) || "slow");
  const [compressResolution, setCompressResolutionState] = useState<CompressResolution>(() => (localStorage.getItem("compress.resolution") as CompressResolution) || "1080");
  const [compressFps, setCompressFpsState] = useState(() => Number(localStorage.getItem("compress.fps") ?? "30"));
  const [compressAudioKbps, setCompressAudioKbpsState] = useState(() => Number(localStorage.getItem("compress.audioKbps") ?? "128"));

  const setCompressEncoder = (v: CompressEncoder) => { setCompressEncoderState(v); localStorage.setItem("compress.encoder", v); };
  const setCompressQuality = (v: number) => { setCompressQualityState(v); localStorage.setItem("compress.quality", String(v)); };
  const setCompressPreset = (v: CompressPreset) => { setCompressPresetState(v); localStorage.setItem("compress.preset", v); };
  const setCompressResolution = (v: CompressResolution) => { setCompressResolutionState(v); localStorage.setItem("compress.resolution", v); };
  const setCompressFps = (v: number) => { setCompressFpsState(v); localStorage.setItem("compress.fps", String(v)); };
  const setCompressAudioKbps = (v: number) => { setCompressAudioKbpsState(v); localStorage.setItem("compress.audioKbps", String(v)); };

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
  const [smoothieRecipeText, setSmoothieRecipeText] = useState(() => localStorage.getItem("smth.recipeText") ?? "");
  const [smoothieRecipeName, setSmoothieRecipeName] = useState(() => localStorage.getItem("smth.recipeName") ?? "");

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
  const [renderCrf, setRenderCrfState] = useState(() => {
    const stored = localStorage.getItem("smth.crf");
    return stored === null || stored === "17" ? 14 : Number(stored);
  });
  const [interpolateOn, setInterpolateOnState] = useState(() => localStorage.getItem("smth.interpolateOn") !== "false");
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
    void applyDiscordPresence(discordPresenceEnabled);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    invoke<PublicAuthSession | null>("get_auth_session")
      .then(setAuthSession)
      .catch(() => setAuthSession(null));
    listen<PublicAuthSession>("auth-session-updated", (event) => {
      setAuthSession(event.payload);
      invoke<{ access: boolean; error?: string }>("check_app_access_detailed")
        .then((res) => { setAppAccess(res.access); setAccessError(res.error || ""); })
        .catch(() => { setAppAccess(false); setAccessError("App access check failed"); });
      setView("settings");
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    invoke<{ access: boolean; error?: string }>("check_app_access_detailed")
      .then((res) => { setAppAccess(res.access); setAccessError(res.error || ""); })
      .catch(() => { setAppAccess(false); setAccessError("App access check failed"); });
  }, []);

  useEffect(() => {
    if (appAccess !== false) return;
    const id = setInterval(async () => {
      try {
        const res = await invoke<{ access: boolean; error?: string }>("check_app_access_detailed");
        setAppAccess(res.access);
        setAccessError(res.error || "");
      } catch { setAppAccess(false); setAccessError("App access check failed"); }
    }, 2000);
    return () => clearInterval(id);
  }, [appAccess]);

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

  const logoutAuth = async () => {
    try {
      await invoke("logout_auth_session");
      setAuthSession(null);
    } catch (e) {
      console.error(e);
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
      if (localStorage.getItem("smth.interpFps") === null) {
        setInterpolateFpsValue(Math.max(renderOutputFps, Math.round(fps * 5)));
      }
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

  const importSmoothieRecipe = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Smoothie recipe", extensions: ["ini"] }] });
      if (typeof sel !== "string") return;
      const text = await invoke<string>("read_smoothie_recipe", { path: sel });
      const name = sel.split(/[\\/]/).pop() ?? "recipe.ini";
      setSmoothieRecipeText(text);
      setSmoothieRecipeName(name);
      localStorage.setItem("smth.recipeText", text);
      localStorage.setItem("smth.recipeName", name);
      setRenderResult(null);
    } catch (e) {
      setRenderResult({ success: false, message: `Recipe import failed: ${e}` });
    }
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
        smoothieRecipe: smoothieRecipeText || null,
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

  const handleCompressFile = (path: string) => {
    setCompressFile(path);
    setCompressResult(null);
    setCompressProgress(null);
  };

  const pickCompressVideo = async () => {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: VIDEO_EXTS }] });
      if (typeof sel === "string") handleCompressFile(sel);
    } catch (e) { console.error(e); }
  };

  const compressVideo = async () => {
    if (!ffmpegPath || !compressFile) return;
    setCompressProcessing(true);
    setCompressResult(null);
    setCompressProgress(0);
    const unlisten = await listen<number>("compress-progress", (e) => {
      setCompressProgress(e.payload);
    });
    try {
      const res = await invoke<ProcessResult>("compress_video", {
        ffmpegPath,
        inputPath: compressFile,
        encoder: compressEncoder,
        quality: compressQuality,
        preset: compressPreset,
        resolution: compressResolution,
        fps: compressFps,
        audioKbps: compressAudioKbps,
      });
      if (res.success && res.output_path) {
        setSuccessModal({ message: res.message, outputPath: res.output_path });
      } else {
        setCompressResult(res);
      }
    } catch (e) {
      setCompressResult({ success: false, message: `Error: ${e}` });
    } finally {
      unlisten();
      setCompressProcessing(false);
      setCompressProgress(null);
    }
  };

  if (view === "trim") {
    handleFileRef.current = handleTrimFile;
  } else if (view === "render") {
    handleFileRef.current = handleRenderFile;
  } else if (view === "clean") {
    handleFileRef.current = handleCleanFile;
  } else if (view === "compress") {
    handleFileRef.current = handleCompressFile;
  } else if (view === "discord") {
    handleFileRef.current = handleDiscordFile;
  } else {
    handleFileRef.current = handleCompressFile;
  }

  const [successModal, setSuccessModal] = useState<{ message: string; outputPath: string } | null>(null);

  const revealInExplorer = async (path: string) => {
    try { await invoke("reveal_in_explorer", { path }); } catch (e) { console.error(e); }
  };

  const canExport = !!ffmpegValid && trimSegs.length > 0 && !trimProcessing;
  const canRender = !!ffmpegValid && !!renderFile && renderInputFps !== null && !renderProcessing && motionRuntimeInstalled === true;
  const canClean = !!cleanFile && !cleanProcessing;
  const canDiscord = !!ffmpegValid && !!discordFile && !discordProcessing;
  const canCompress = !!ffmpegValid && !!compressFile && !compressProcessing;
  const recommendedInterpolateFps = renderInputFps !== null
    ? Math.max(renderOutputFps, Math.round(renderInputFps * 5))
    : 360;
  const interpolationPresetFps = Array.from(new Set([recommendedInterpolateFps, 360, 480, 960]));
  const cleanFileName = cleanFile.split(/[\\/]/).pop() ?? "";
  const renderFileName = renderFile.split(/[\\/]/).pop() ?? "";
  const discordFileName = discordFile.split(/[\\/]/).pop() ?? "";
  const compressFileName = compressFile.split(/[\\/]/).pop() ?? "";
  const trimTotalLen = trimSegs.reduce((acc, s) => acc + (s.outPoint - s.inPoint), 0);
  const renderWorkingFps = interpolateOn && interpolateFpsValue > 0 ? interpolateFpsValue : (renderInputFps ?? renderOutputFps);
  const renderFramesBlended = Math.max(1, Math.round(renderWorkingFps / renderOutputFps * blurAmount));

  return (
    <div className="relative flex h-screen overflow-hidden bg-[#0b0c0e] text-white antialiased">
      {/* background */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-x-0 top-0 h-px bg-white/10" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-black" />
      </div>

      {/* sidebar */}
      <aside
        className={cn(
          'relative z-10 flex shrink-0 flex-col border-r border-white/[0.075] bg-[#090a0c]/95 transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]',
          sidebarCollapsed ? 'w-[58px]' : 'w-[204px]'
        )}
      >
        {/* logo */}
        <div className="flex h-12 items-center justify-center px-3">
          <button
            type="button"
            onClick={() => navigate("home")}
            className={cn(
              "group flex h-8 w-8 items-center justify-center rounded-lg outline-none transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96]",
              "focus-visible:ring-2 focus-visible:ring-white/15"
            )}
            aria-label="Home"
          >
            <img
              src="/logo.png"
              alt="xype"
              className="h-5 w-5 shrink-0 opacity-90 transition-opacity group-hover:opacity-100"
            />
          </button>
        </div>

        {/* nav */}
        <nav className="flex-1 px-2 pb-2">
          <div className="space-y-1">
            <SidebarItem
              collapsed={sidebarCollapsed}
              active={view === 'discord'}
              onClick={() => navigate('discord')}
              icon={<SiDiscord />}
            >
              Discord Compress
            </SidebarItem>

            <SidebarItem
              collapsed={sidebarCollapsed}
              active={view === 'compress'}
              onClick={() => navigate('compress')}
              icon={<PiFilmSlateDuotone />}
            >
              Quality Compress
            </SidebarItem>

            <SidebarItem
              collapsed={sidebarCollapsed}
              active={view === 'clean'}
              onClick={() => navigate('clean')}
              icon={<PiSparkleDuotone />}
              disabled
              tooltip="Currently patched. We're looking for a fix."
            >
              TikTok Optimizer
            </SidebarItem>

            <SidebarItem
              collapsed={sidebarCollapsed}
              active={view === 'trim'}
              onClick={() => navigate('trim')}
              icon={<PiScissorsDuotone />}
            >
              Lossless Trim
            </SidebarItem>

            <SidebarItem
              collapsed={sidebarCollapsed}
              active={view === 'render'}
              onClick={() => navigate('render')}
              icon={<PiFilmReelDuotone />}
            >
              Motion Blur
            </SidebarItem>

            <div className="my-2 border-t border-white/[0.055]" />

            <SidebarItem
              collapsed={sidebarCollapsed}
              active={view === 'settings'}
              onClick={() => navigate('settings')}
              icon={<PiGearSixDuotone />}
            >
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
        </nav>
      </aside>

      {/* main */}
      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">

        {/* Home */}
        {view === "home" && (
          <main className="flex-1 overflow-auto">
            <div className="mx-auto flex min-h-full w-full max-w-3xl items-center p-6">
              <section className="w-full overflow-hidden rounded-[16px] border border-white/[0.075] bg-[#101115] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                {[
                  { title: "Quality Compress", sub: "HandBrake-style output for TikTok and uploads.", icon: <PiFilmSlateDuotone />, view: "compress" as View },
                  { title: "Discord Compress", sub: "Fit clips under the 8 MB limit.", icon: <SiDiscord />, view: "discord" as View },
                  { title: "Lossless Trim", sub: "Cut clips without re-encoding.", icon: <PiScissorsDuotone />, view: "trim" as View },
                  { title: "Motion Blur", sub: "Frame blending and Smoothie recipes.", icon: <PiFilmReelDuotone />, view: "render" as View },
                  { title: "Settings", sub: "FFmpeg, account, and updates.", icon: <PiGearSixDuotone />, view: "settings" as View },
                ].map((tool, index) => (
                  <button key={tool.title} type="button" onClick={() => navigate(tool.view)}
                    className={cn(
                      "anim-slide-up group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-white/[0.035] active:bg-white/[0.05]",
                      index > 0 && "border-t border-white/[0.055]"
                    )}
                    style={{ animationDelay: `${80 + index * 25}ms` }}>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.035] text-[17px] text-white/65 transition-colors group-hover:text-white/85">
                      {tool.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium tracking-[-0.005em] text-white/90">{tool.title}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-white/40">{tool.sub}</span>
                    </span>
                    <span className="text-[12px] text-white/25 transition-colors group-hover:text-white/45">Open</span>
                  </button>
                ))}
              </section>
            </div>
          </main>
        )}

        {/* ─ Clean ─ */}
        {view === "clean" && (
          <>
            <Header {...VIEW_META.clean} />

            {!cleanFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-5">
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickCleanVideo}
                    label="Drop MP4 here" hint="or click to browse · MP4 only" />
                </div>
              </main>
            )}

            {!!cleanFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-5 gap-4">

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-4 rounded-[14px] border border-white/[0.075] bg-[#111216] p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.075] bg-white/[0.03]">
                      <PiFilmSlateDuotone className="text-[20px] text-white/60" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-white">
                        {cleanFileName}
                      </p>

                      <p className="mt-1 text-sm text-white/30">
                        Ready to process
                      </p>
                    </div>

                    <button type="button"
                      onClick={() => { setCleanFile(""); setCleanResult(null); }}
                      className="text-white/30 hover:text-white/80 shrink-0 transition-colors duration-150">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  <div className="anim-slide-up grid grid-cols-3 overflow-hidden rounded-[14px] border border-white/[0.075] bg-[#111216]" style={{ animationDelay: "40ms" }}>
                    <StatusCell label="Mode" value="Metadata patch" />
                    <StatusCell label="Encode" value="None" />
                    <StatusCell label="Output" value="New MP4 copy" />
                  </div>

                  <div className="flex-1" />

                  <div className="sticky bottom-0 -mx-5 mt-auto space-y-3 border-t border-white/[0.075] bg-[#0b0c0e]/95 px-5 py-4 backdrop-blur-xl" style={{ animationDelay: "100ms" }}>
                    <button type="button" onClick={patchClean} disabled={!canClean}
                      className={cn(
                        "w-full h-10 rounded-xl text-sm font-medium transition-colors",
                        canClean
                          ? "bg-white text-black hover:bg-white/90"
                          : "bg-white/5 text-white/20 cursor-not-allowed"
                      )}>
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
                <div className="flex-1 flex flex-col gap-4 p-5">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickTrimVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {/* Loaded state — true flex fill, video takes all spare height */}
            {!!trimFile && (
              <main className="flex-1 overflow-hidden flex flex-col">
                <div key="filled" className="flex-1 flex flex-col gap-4 p-5 min-h-0">

                  {/* Video — flex-1 fills remaining vertical space */}
                  <div className="anim-scale-in flex-1 min-h-[120px] rounded-[16px] overflow-hidden bg-black border border-white/[0.075]">
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
                      className="w-9 h-9 rounded-xl bg-[#111216] border border-white/[0.075] text-white/70 flex items-center justify-center hover:bg-white/[0.05] hover:text-white transition-colors shrink-0"
                    >
                      {trimPlaying ? <PiPauseFill className="text-sm" /> : <PiPlayFill className="text-sm" />}
                    </button>
                    <span className="max-w-[260px] truncate text-[12px] font-medium text-white/55">{trimFileName}</span>
                    <span className="h-4 w-px bg-white/[0.075]" />
                    <span className="text-sm font-mono tabular-nums text-white/70">{fmt(trimCurrentTime)}</span>
                    <span className="text-white/20 text-sm">/</span>
                    <span className="text-sm font-mono tabular-nums text-white/40">{fmt(trimDuration)}</span>
                    <div className="flex-1" />
                    {(trimSegs.length > 0 || trimPendingIn !== null) && (
                      <button type="button"
                        onClick={() => { setTrimSegs([]); setTrimPendingIn(null); }}
                        className="text-[12px] text-white/30 hover:text-white/80 transition-colors">
                        Clear all
                      </button>
                    )}
                    <button type="button"
                      onClick={() => { setTrimFile(""); setTrimVideoSrc(""); setTrimSegs([]); setTrimPendingIn(null); setTrimResult(null); }}
                      className="text-white/30 hover:text-white/80 transition-colors shrink-0">
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
                      <span className="text-[11px] font-mono tabular-nums text-white/30">
                        {trimPendingIn !== null
                          ? <span className="anim-fade text-amber-400/80">[ {fmt(trimPendingIn)} …</span>
                          : trimSegs.length > 0
                            ? `${trimSegs.length} segment${trimSegs.length > 1 ? "s" : ""}`
                            : "press I to mark in"
                        }
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-white/30">
                        {trimTotalLen > 0 ? fmt(trimTotalLen) : ""}
                      </span>
                    </div>
                  </div>

                  {/* Set In / Set Out */}
                  <div className="anim-slide-up flex gap-3 shrink-0" style={{ animationDelay: "100ms" }}>
                    <button type="button" onClick={markIn}
                      className={cn(
                        "flex-1 h-10 flex items-center justify-center gap-2 rounded-xl border text-sm font-medium transition-colors",
                        trimPendingIn !== null
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                          : "border-white/[0.075] bg-[#111216] text-white/70 hover:bg-white/[0.05] hover:text-white"
                      )}>
                      <span className="font-mono font-bold opacity-50 text-base leading-none">[</span>
                      <span>Set In</span>
                      <kbd className="text-[10px] font-mono opacity-35">I</kbd>
                    </button>
                    <button type="button" onClick={markOut} disabled={trimPendingIn === null}
                      className={cn(
                        "flex-1 h-10 flex items-center justify-center gap-2 rounded-xl border text-sm font-medium transition-colors",
                        trimPendingIn !== null
                          ? "border-white/[0.075] bg-[#111216] text-white/70 hover:bg-white/[0.05] hover:text-white cursor-pointer"
                          : "border-white/[0.03] text-white/20 cursor-not-allowed"
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
                          className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/[0.075] bg-[#111216] hover:bg-white/[0.05] transition-colors group">
                          <span className="text-[10px] font-semibold text-white/30 w-3 shrink-0 tabular-nums">{i + 1}</span>
                          <span className="font-mono text-[12px] flex-1 text-white/70 tabular-nums">
                            {fmt(seg.inPoint)}
                            <span className="text-white/30 mx-1.5">→</span>
                            {fmt(seg.outPoint)}
                          </span>
                          <span className="text-[11px] font-mono tabular-nums text-white/30 shrink-0">{fmt(seg.outPoint - seg.inPoint)}</span>
                          <button type="button"
                            onClick={() => setTrimSegs(prev => prev.filter(s => s.id !== seg.id))}
                            className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-destructive transition-colors ml-1 shrink-0">
                            <PiXCircleFill className="text-sm" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Export — pinned at bottom */}
                  <div className="shrink-0 space-y-3 pt-1">
                    <div className="border-t border-white/[0.075]" />
                    <button type="button" onClick={exportClip} disabled={!canExport}
                      className={cn(
                        "w-full h-10 rounded-xl text-sm font-medium transition-colors",
                        canExport
                          ? "bg-white text-black hover:bg-white/90"
                          : "bg-white/5 text-white/20 cursor-not-allowed"
                      )}>
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
                <div className="flex-1 flex flex-col gap-4 p-5">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickRenderVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {/* Loaded state */}
            {!!renderFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-5 gap-4">

                  {/* Motion runtime install card */}
                  {motionRuntimeInstalled === false && (
                    <div className="anim-slide-up rounded-[16px] border border-white/[0.075] bg-[#111216] p-4 space-y-3">
                      <div className="flex items-start gap-2.5">
                        <PiDownloadSimpleDuotone className="text-emerald-400 text-lg shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold text-white">Motion engine not installed</p>
                          <p className="text-[12px] text-white/50 mt-0.5 leading-relaxed">
                            The high-quality motion blur engine uses VapourSynth plugins (~40 MB). Click below to install automatically.
                          </p>
                        </div>
                      </div>
                      {motionRuntimeInstalling ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[13px] text-white/60">Downloading motion engine…</span>
                            <span className="text-[12px] font-mono text-white/30 tabular-nums">{motionRuntimeProgress ?? 0}%</span>
                          </div>
                          <div className="h-1 overflow-hidden rounded-full bg-white/[0.04]">
                            <div className="h-full rounded-full bg-white/40 transition-[width] duration-300"
                              style={{ width: `${motionRuntimeProgress ?? 0}%` }} />
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={installMotionRuntime}
                          className="w-full h-10 rounded-xl bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-white/90 flex items-center justify-center gap-2">
                          <PiDownloadSimpleDuotone className="text-base" />
                          Install motion engine
                        </button>
                      )}
                    </div>
                  )}

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-4 rounded-[14px] border border-white/[0.075] bg-[#111216] p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.075] bg-white/[0.03]">
                      <PiFilmSlateDuotone className="text-[20px] text-white/60" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-white">
                        {renderFileName}
                      </p>

                      <div className="mt-1 text-sm text-white/30 h-5 flex items-center">
                        {renderDetecting && (
                          <span className="anim-fade flex items-center gap-1.5">
                            <PiSpinnerGapBold className="animate-spin" />Detecting FPS…
                          </span>
                        )}
                        {!renderDetecting && renderInputFps !== null && (
                          <span className="anim-fade flex items-center gap-1.5">
                            Source: <span className="text-white font-semibold">{Math.round(renderInputFps)} fps</span>
                          </span>
                        )}
                        {!renderDetecting && renderInputFps === null && (
                          <span className="anim-fade text-destructive">FPS detection failed</span>
                        )}
                      </div>
                    </div>

                    <button type="button"
                      onClick={() => { setRenderFile(""); setRenderInputFps(null); setRenderResult(null); }}
                      className="text-white/30 hover:text-white/80 shrink-0 transition-colors duration-150">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  {/* ── Blur Amount ── */}
                  <div className="anim-slide-up grid grid-cols-4 overflow-hidden rounded-[14px] border border-white/[0.075] bg-[#111216]" style={{ animationDelay: "35ms" }}>
                    <StatusCell label="Source" value={renderInputFps !== null ? `${Math.round(renderInputFps)} fps` : renderDetecting ? "Detecting" : "Unknown"} />
                    <StatusCell label="Output" value={`${renderOutputFps} fps`} />
                    <StatusCell label="Blend" value={`${renderFramesBlended} frames`} />
                    <StatusCell label="Speed" value={`${renderTimescale}x`} />
                  </div>

                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "40ms" }}>
                    <div className="flex items-baseline justify-between">
                      <p className="text-[12px] font-medium text-white/30">Blur Amount</p>
                      <p className="text-[12px] text-white/30 tabular-nums">
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
                            "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                            blurAmount === v
                              ? "bg-white text-black border-white"
                              : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                          )}>
                          {label}
                        </button>
                      ))}
                      <div className="flex items-center gap-1">
                        <input
                          type="number" min="0.01" max="3" step="0.05"
                          value={blurAmount}
                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0 && v <= 3) setBlurAmount(v); }}
                          className="w-14 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20 tabular-nums"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="anim-slide-up rounded-[16px] border border-white/[0.075] bg-[#111216] p-4 space-y-3" style={{ animationDelay: "55ms" }}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[12px] font-medium text-white/30">Smoothie Recipe</p>
                        <p className="mt-1 text-[12px] text-white/40">
                          {smoothieRecipeName ? `Using ${smoothieRecipeName}` : "Optional: import recipe.ini from Smoothie for matching settings."}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {smoothieRecipeText && (
                          <button type="button" onClick={() => { setSmoothieRecipeText(""); setSmoothieRecipeName(""); localStorage.removeItem("smth.recipeText"); localStorage.removeItem("smth.recipeName"); }}
                            className="h-9 rounded-xl border border-white/[0.075] bg-[#111216] px-4 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white">
                            Clear
                          </button>
                        )}
                        <button type="button" onClick={importSmoothieRecipe}
                          className="h-9 rounded-xl border border-white/[0.075] bg-[#111216] px-4 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white">
                          Import .ini
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ── Output FPS ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "70ms" }}>
                    <p className="text-[12px] font-medium text-white/30">Output FPS</p>
                    <div className="flex items-center gap-2">
                      {[30, 60, 120].map((fps) => (
                        <button key={fps} type="button" onClick={() => setRenderOutputFps(fps)}
                          className={cn(
                            "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                            renderOutputFps === fps
                              ? "bg-white text-black border-white"
                              : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                          )}>
                          {fps}
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="1" max="960"
                          value={renderOutputFps}
                          onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) setRenderOutputFps(v); }}
                          className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20 tabular-nums"
                        />
                        <span className="text-[12px] text-white/30">fps</span>
                      </div>
                    </div>
                  </div>

                  {/* ── Weighting ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "100ms" }}>
                    <p className="text-[12px] font-medium text-white/30">Weighting</p>
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
                            "flex-1 h-14 rounded-xl border font-medium flex flex-col items-center justify-center gap-0.5 transition-colors",
                            blendWeighting === id
                              ? "bg-white text-black border-white"
                              : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                          )}>
                          <span className="text-[11px] font-semibold leading-none">{label}</span>
                          <span className={cn("text-[9px] font-normal mt-0.5", blendWeighting === id ? "opacity-60 text-black/60" : "opacity-35 text-white/30")}>{hint}</span>
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
                          className="w-full h-10 px-3 font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20"
                        />
                        <p className="text-[11px] text-white/30">Space-separated weights — one per blended frame</p>
                      </div>
                    )}
                  </div>

                  {/* ── Interpolation ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "130ms" }}>
                    <div className="flex items-center justify-between">
                      <p className="text-[12px] font-medium text-white/30">Interpolation</p>
                      <p className="text-[11px] text-white/30">SVP-style optical flow</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => setInterpolateOn(false)}
                        className={cn("h-10 px-5 rounded-xl border text-sm font-medium transition-colors",
                          !interpolateOn
                            ? "bg-white text-black border-white"
                            : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]")}>
                        Off
                      </button>
                      <button type="button" onClick={() => setInterpolateOn(true)}
                        className={cn("h-10 px-5 rounded-xl border text-sm font-medium transition-colors",
                          interpolateOn
                            ? "bg-white text-black border-white"
                            : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]")}>
                        On
                      </button>
                      {interpolateOn && (
                        <div className="anim-fade ml-2 flex items-center gap-2 flex-1">
                          {interpolationPresetFps.map(fps => (
                            <button key={fps} type="button" onClick={() => setInterpolateFpsValue(fps)}
                              className={cn("h-10 px-3 rounded-xl border text-sm font-medium transition-colors",
                                interpolateFpsValue === fps
                                  ? "bg-white text-black border-white"
                                  : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]")}>
                              {fps === recommendedInterpolateFps ? `${fps}*` : fps}
                            </button>
                          ))}
                          <div className="ml-auto flex items-center gap-1.5">
                            <input
                              type="number" min="1" max="9999"
                              value={interpolateFpsValue}
                              onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) setInterpolateFpsValue(v); }}
                              className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20 tabular-nums"
                            />
                            <span className="text-[12px] text-white/30">fps</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Timescale ── */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "160ms" }}>
                    <p className="text-[12px] font-medium text-white/30">Timescale</p>
                    <div className="flex items-center gap-2">
                      {[0.25, 0.5, 1, 2].map((ts) => (
                        <button key={ts} type="button" onClick={() => setRenderTimescale(ts)}
                          className={cn(
                            "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                            renderTimescale === ts
                              ? "bg-white text-black border-white"
                              : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                          )}>
                          {ts}×
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="0.05" max="10" step="0.05"
                          value={renderTimescale}
                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setRenderTimescale(v); }}
                          className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20 tabular-nums"
                        />
                        <span className="text-[12px] text-white/30">×</span>
                      </div>
                    </div>
                    <p className="text-[11px] text-white/30">
                      {renderTimescale === 1 ? "Normal speed" : renderTimescale < 1 ? `Slow to ${Math.round(renderTimescale * 100)}%` : `Speed up ${renderTimescale}×`}
                    </p>
                  </div>

                  {/* Output quality + encoder */}
                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "200ms" }}>
                    <p className="text-[12px] font-medium text-white/30">Output</p>
                    <div className="grid grid-cols-2 gap-3">
                      {/* Quality */}
                      <div className="space-y-2">
                        <p className="text-[11px] text-white/30 font-medium">Quality</p>
                        <div className="flex gap-2">
                          {[
                            { label: "High", crf: 14 },
                            { label: "Med", crf: 18 },
                            { label: "Low", crf: 24 },
                          ].map(({ label, crf }) => (
                            <button key={crf} type="button" onClick={() => setRenderCrf(crf)}
                              className={cn(
                                "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                                renderCrf === crf
                                  ? "bg-white text-black border-white"
                                  : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                              )}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* Encoder */}
                      <div className="space-y-2">
                        <p className="text-[11px] text-white/30 font-medium">Encoder</p>
                        <div className="flex gap-2">
                          {[
                            { label: "CPU", id: "libx264" },
                            { label: "GPU", id: "h264_nvenc" },
                          ].map(({ label, id }) => (
                            <button key={id} type="button" onClick={() => setRenderEncoder(id)}
                              className={cn(
                                "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                                renderEncoder === id
                                  ? "bg-white text-black border-white"
                                  : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                              )}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <p className="text-[11px] text-white/30">
                      CRF {renderCrf} · {renderEncoder === "h264_nvenc" ? "NVENC — requires NVIDIA GPU" : "libx264"}
                    </p>
                  </div>

                  <div className="flex-1" />

                  {/* Render */}
                  <div className="sticky bottom-0 -mx-5 mt-auto space-y-3 border-t border-white/[0.075] bg-[#0b0c0e]/95 px-5 py-4 backdrop-blur-xl" style={{ animationDelay: "200ms" }}>
                    {renderProcessing ? (
                      <div className="space-y-3">
                        <div className="h-1 overflow-hidden rounded-full bg-white/[0.04]">
                          <div
                            className="h-full rounded-full bg-white/40 transition-[width] duration-300"
                            style={{ width: `${Math.round((renderProgress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-white/30 tabular-nums">
                          <span>{Math.round((renderProgress ?? 0) * 100)}%</span>
                          <span className="text-[11px] opacity-60">{renderEncoder === "h264_nvenc" ? "NVENC" : "libx264"}</span>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={processRender} disabled={!canRender}
                        className={cn(
                          "w-full h-10 rounded-xl text-sm font-medium transition-colors",
                          canRender
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-white/5 text-white/20 cursor-not-allowed"
                        )}>
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

        {/* Quality Compress */}
        {view === "compress" && (
          <>
            <Header {...VIEW_META.compress} />

            {!compressFile && (
              <main className="flex-1 flex flex-col overflow-auto">
                <div className="flex-1 flex flex-col gap-4 p-5">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickCompressVideo}
                    label="Drop video here" hint="or click to browse - MP4, MOV, MKV, AVI..." />
                </div>
              </main>
            )}

            {!!compressFile && (
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-5 gap-4">
                  <div className="anim-slide-up flex items-center gap-4 rounded-[14px] border border-white/[0.075] bg-[#111216] p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.075] bg-white/[0.03]">
                      <PiFilmSlateDuotone className="text-[20px] text-white/60" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-white">{compressFileName}</p>
                      <p className="mt-1 text-sm text-white/30">Ready to compress</p>
                    </div>
                    <button type="button"
                      onClick={() => { setCompressFile(""); setCompressResult(null); setCompressProgress(null); }}
                      className="text-white/30 hover:text-white/80 shrink-0 transition-colors duration-150">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  <div className="anim-slide-up grid grid-cols-4 overflow-hidden rounded-[14px] border border-white/[0.075] bg-[#111216]" style={{ animationDelay: "35ms" }}>
                    <StatusCell label="Quality" value={`CRF ${compressQuality}`} />
                    <StatusCell label="Resolution" value={compressResolution === "source" ? "Source" : `${compressResolution}p`} />
                    <StatusCell label="FPS" value={compressFps === 0 ? "Source" : `${compressFps}`} />
                    <StatusCell label="Audio" value={`${compressAudioKbps}k`} />
                  </div>

                  <div className="anim-slide-up space-y-3" style={{ animationDelay: "40ms" }}>
                    <p className="text-[12px] font-medium text-white/30">Preset</p>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: "Balanced", hint: "TikTok default", quality: 20, res: "1080" as CompressResolution, fps: 30, audio: 128 },
                        { label: "Smaller", hint: "more savings", quality: 24, res: "720" as CompressResolution, fps: 30, audio: 96 },
                        { label: "Archive", hint: "best detail", quality: 18, res: "source" as CompressResolution, fps: 0, audio: 160 },
                      ].map((preset) => (
                        <button key={preset.label} type="button"
                          onClick={() => {
                            setCompressQuality(preset.quality);
                            setCompressResolution(preset.res);
                            setCompressFps(preset.fps);
                            setCompressAudioKbps(preset.audio);
                            setCompressEncoder("libx264");
                            setCompressPreset("slow");
                          }}
                          className="h-14 rounded-xl border border-white/[0.075] bg-white/[0.02] text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/80">
                          <span className="block text-[12px] font-semibold">{preset.label}</span>
                          <span className="mt-1 block text-[10px] opacity-50">{preset.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="anim-slide-up grid grid-cols-1 gap-4 lg:grid-cols-2" style={{ animationDelay: "70ms" }}>
                    <div className="space-y-3">
                      <div className="flex items-baseline justify-between">
                        <p className="text-[12px] font-medium text-white/30">Quality</p>
                        <p className="text-[12px] text-white/30 tabular-nums">RF/CRF {compressQuality}</p>
                      </div>
                      <div className="flex gap-2">
                        {[18, 20, 22, 24].map((value) => (
                          <button key={value} type="button" onClick={() => setCompressQuality(value)}
                            className={cn(
                              "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                              compressQuality === value
                                ? "bg-white text-black border-white"
                                : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                            )}>
                            {value}
                          </button>
                        ))}
                        <input
                          type="number" min="10" max="32"
                          value={compressQuality}
                          onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 10 && v <= 32) setCompressQuality(v); }}
                          className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20 tabular-nums"
                        />
                      </div>
                      <p className="text-[11px] text-white/30">18 is very clean, 20 is a good default, 24 is visibly smaller.</p>
                    </div>

                    <div className="space-y-3">
                      <p className="text-[12px] font-medium text-white/30">Encoder</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: "H.264", id: "libx264" as CompressEncoder },
                          { label: "H.265", id: "libx265" as CompressEncoder },
                          { label: "NVENC", id: "h264_nvenc" as CompressEncoder },
                        ].map(({ label, id }) => (
                          <button key={id} type="button" onClick={() => setCompressEncoder(id)}
                            className={cn(
                              "h-10 rounded-xl border text-sm font-medium transition-colors",
                              compressEncoder === id
                                ? "bg-white text-black border-white"
                                : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                            )}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-[12px] font-medium text-white/30">Resolution cap</p>
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: "Source", id: "source" as CompressResolution },
                          { label: "1080p", id: "1080" as CompressResolution },
                          { label: "720p", id: "720" as CompressResolution },
                          { label: "480p", id: "480" as CompressResolution },
                        ].map(({ label, id }) => (
                          <button key={id} type="button" onClick={() => setCompressResolution(id)}
                            className={cn(
                              "h-10 rounded-xl border text-sm font-medium transition-colors",
                              compressResolution === id
                                ? "bg-white text-black border-white"
                                : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                            )}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-[12px] font-medium text-white/30">FPS cap</p>
                      <div className="flex gap-2">
                        {[0, 30, 60].map((fps) => (
                          <button key={fps} type="button" onClick={() => setCompressFps(fps)}
                            className={cn(
                              "flex-1 h-10 rounded-xl border text-sm font-medium transition-colors",
                              compressFps === fps
                                ? "bg-white text-black border-white"
                                : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                            )}>
                            {fps === 0 ? "Source" : fps}
                          </button>
                        ))}
                        <input
                          type="number" min="0" max="240"
                          value={compressFps}
                          onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0 && v <= 240) setCompressFps(v); }}
                          className="w-16 h-10 px-2 text-center font-mono text-[13px] bg-transparent border border-white/[0.075] rounded-xl outline-none text-white placeholder:text-white/20 focus:border-white/20 tabular-nums"
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-[12px] font-medium text-white/30">Preset</p>
                      <div className="grid grid-cols-3 gap-2">
                        {(["medium", "slow", "slower"] as CompressPreset[]).map((preset) => (
                          <button key={preset} type="button" onClick={() => setCompressPreset(preset)}
                            className={cn(
                              "h-10 rounded-xl border text-sm font-medium capitalize transition-colors",
                              compressPreset === preset
                                ? "bg-white text-black border-white"
                                : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                            )}>
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-[12px] font-medium text-white/30">Audio</p>
                      <div className="grid grid-cols-4 gap-2">
                        {[96, 128, 160, 192].map((kbps) => (
                          <button key={kbps} type="button" onClick={() => setCompressAudioKbps(kbps)}
                            className={cn(
                              "h-10 rounded-xl border text-sm font-medium transition-colors",
                              compressAudioKbps === kbps
                                ? "bg-white text-black border-white"
                                : "border-white/[0.075] text-white/30 hover:text-white/80 hover:bg-white/[0.03]"
                            )}>
                            {kbps}k
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex-1" />

                  <div className="sticky bottom-0 -mx-5 mt-auto space-y-3 border-t border-white/[0.075] bg-[#0b0c0e]/95 px-5 py-4 backdrop-blur-xl" style={{ animationDelay: "140ms" }}>
                    {compressProcessing ? (
                      <div className="space-y-3">
                        <div className="h-1 overflow-hidden rounded-full bg-white/[0.04]">
                          <div
                            className="h-full rounded-full bg-white/40 transition-[width] duration-300"
                            style={{ width: `${Math.round((compressProgress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-white/30 tabular-nums">
                          <span>{Math.round((compressProgress ?? 0) * 100)}%</span>
                          <span className="text-[11px] opacity-60">{compressEncoder} - CRF {compressQuality}</span>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={compressVideo} disabled={!canCompress}
                        className={cn(
                          "w-full h-10 rounded-xl text-sm font-medium transition-colors",
                          canCompress
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-white/5 text-white/20 cursor-not-allowed"
                        )}>
                        Compress
                      </button>
                    )}
                    {compressResult && <ResultBanner result={compressResult} />}
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
                <div className="flex-1 flex flex-col gap-4 p-5">
                  {!ffmpegValid && <FfmpegWarning onClick={() => setView("settings")} />}
                  <DropZone key="empty" isDragOver={isDragOver} onClick={pickDiscordVideo}
                    label="Drop video here" hint="or click to browse · MP4, MOV, MKV, AVI…" />
                </div>
              </main>
            )}

            {!!discordFile && (<>
              <main className="flex-1 overflow-auto">
                <div key="filled" className="min-h-full flex flex-col p-5 gap-4">

                  {/* File card */}
                  <div className="anim-slide-up flex items-center gap-4 rounded-[14px] border border-white/[0.075] bg-[#111216] p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.075] bg-white/[0.03]">
                      <PiFilmSlateDuotone className="text-[20px] text-white/60" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-white">
                        {discordFileName}
                      </p>

                      <p className="mt-1 text-sm text-white/30">
                        Ready to process
                      </p>
                    </div>

                    <button type="button"
                      onClick={() => { setDiscordFile(""); setDiscordResult(null); setDiscordProgress(null); }}
                      className="text-white/30 hover:text-white/80 shrink-0 transition-colors duration-150">
                      <PiXCircleFill className="text-xl" />
                    </button>
                  </div>

                  <div className="anim-slide-up grid grid-cols-3 overflow-hidden rounded-[14px] border border-white/[0.075] bg-[#111216]" style={{ animationDelay: "40ms" }}>
                    <StatusCell label="Target" value="8 MB" />
                    <StatusCell label="Video" value="H.264" />
                    <StatusCell label="Preset" value="Veryfast" />
                  </div>

                  <div className="flex-1" />

                  {/* Compress */}
                  <div className="sticky bottom-0 -mx-5 mt-auto space-y-3 border-t border-white/[0.075] bg-[#0b0c0e]/95 px-5 py-4 backdrop-blur-xl" style={{ animationDelay: "100ms" }}>
                    {discordProcessing ? (
                      <div className="space-y-3">
                        <div className="h-1 overflow-hidden rounded-full bg-white/[0.04]">
                          <div
                            className="h-full rounded-full bg-white/40 transition-[width] duration-300"
                            style={{ width: `${Math.round((discordProgress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[12px] text-white/30 tabular-nums">
                          <span>{Math.round((discordProgress ?? 0) * 100)}%</span>
                          <span className="text-[11px] opacity-60">libx264 · veryfast</span>
                        </div>
                      </div>
                    ) : (
                      <button type="button" onClick={compressForDiscord} disabled={!canDiscord}
                        className={cn(
                          "w-full h-10 rounded-xl text-sm font-medium transition-colors",
                          canDiscord
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-white/5 text-white/20 cursor-not-allowed"
                        )}>
                        Compress for Discord
                      </button>
                    )}
                    {discordResult && <ResultBanner result={discordResult} />}
                  </div>

                </div>
              </main>
            </>)}
          </>
        )}

        {/* ─ Settings ─ */}
        {view === "settings" && (
          <>
            <Header {...VIEW_META.settings} />
            <main className="flex-1 overflow-auto">
              <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-5 p-4 sm:p-6 lg:p-6 xl:grid-cols-[minmax(0,1fr)_360px]">

                {/* left */}
                <div className="space-y-6">
                  <div className="rounded-[14px] border border-white/[0.075] bg-[#111216]">
                    <div className="border-b border-white/[0.075] px-5 py-5 sm:px-7 sm:py-6">
                      <p className="text-[15px] font-medium text-white">
                        FFmpeg executable
                      </p>

                      <p className="mt-1 text-sm text-white/35">
                        Used for compression, trimming, rendering, and metadata reads.
                      </p>
                    </div>

                    <div className="p-5 sm:p-7">
                      <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <input type="text" value={ffmpegPath} onChange={e => saveFfmpegPath(e.target.value)}
                          placeholder="C:\path\to\ffmpeg.exe" spellCheck={false}
                          className={cn("h-10 min-w-0 rounded-xl border bg-white/[0.02] border-white/[0.075] px-4 font-mono text-[13px] text-white outline-none placeholder:text-white/20 transition-colors focus:border-white/20",
                            ffmpegValid === false ? "border-destructive/50" : "border-white/[0.075]")} />
                        <button type="button" onClick={pickFfmpeg}
                          className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/[0.075] bg-[#111216] px-5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white sm:justify-start">
                          <PiFolderOpenDuotone className="text-base" />Browse
                        </button>
                        <span className="hidden size-11 place-items-center sm:grid">
                          {ffmpegValid === true && <PiCheckCircleFill className="anim-pop text-emerald-500 text-lg shrink-0" />}
                          {ffmpegValid === false && <PiXCircleFill className="anim-scale-in text-destructive text-lg shrink-0" />}
                        </span>
                      </div>
                      {ffmpegValid === true && (
                        <p className="anim-slide-down mt-2 text-[12px] text-emerald-400 sm:hidden">FFmpeg is configured.</p>
                      )}
                      {ffmpegValid === false && (
                        <p className="anim-slide-down text-[12px] text-destructive mt-2">Not a valid ffmpeg executable.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[14px] border border-white/[0.075] bg-[#111216]">
                    <div className="border-b border-white/[0.075] px-5 py-5 sm:px-7 sm:py-6">
                      <p className="text-[15px] font-medium text-white">
                        Account
                      </p>

                      <p className="mt-1 text-sm text-white/35">
                        Manage your subscription and auth session.
                      </p>
                    </div>

                    <div className="p-5 sm:p-7">
                      {authSession ? (
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <PiCheckCircleFill className="text-emerald-400 shrink-0" />
                              <p className="text-[14px] font-medium text-white">Signed in</p>
                            </div>
                            <p className="mt-1 truncate text-sm text-white/45">{authSession.email}</p>
                          </div>
                          <button type="button" onClick={logoutAuth}
                            className="h-10 shrink-0 rounded-xl border border-white/[0.075] bg-[#111216] px-5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white">
                            Log out
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-[14px] font-medium text-white/70">Not signed in</p>
                            <p className="mt-1 text-sm text-white/35">Log in to verify your subscription.</p>
                          </div>
                          <button type="button" onClick={() => openUrl("https://xype.gg/login")}
                            className="h-10 shrink-0 rounded-xl bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-white/90">
                            Log in
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[14px] border border-white/[0.075] bg-[#111216]">
                    <div className="border-b border-white/[0.075] px-5 py-5 sm:px-7 sm:py-6">
                      <p className="text-[15px] font-medium text-white">
                        Discord Rich Presence
                      </p>

                      <p className="mt-1 text-sm text-white/35">
                        Show xype as your current Discord activity.
                      </p>
                    </div>

                    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/[0.075] bg-white/[0.03] text-white/65">
                          <SiDiscord className="text-[17px]" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium text-white/80">
                            {discordPresenceEnabled ? "Presence enabled" : "Presence disabled"}
                          </p>
                          <p className={cn(
                            "mt-1 text-[12px]",
                            discordPresenceStatus === "connected" && "text-emerald-400/80",
                            discordPresenceStatus === "error" && "text-destructive",
                            discordPresenceStatus !== "connected" && discordPresenceStatus !== "error" && "text-white/35"
                          )}>
                            {discordPresenceStatus === "connected"
                              ? "Connected to Discord."
                              : discordPresenceStatus === "error"
                                ? "Discord is not connected or the client ID is missing."
                                : discordPresenceStatus === "loading"
                                  ? "Checking Discord..."
                                  : "Discord activity will stay hidden."}
                          </p>
                        </div>
                      </div>

                      <button type="button"
                        onClick={() => setDiscordPresenceEnabled(!discordPresenceEnabled)}
                        className={cn(
                          "flex h-10 w-full shrink-0 items-center justify-center rounded-xl border px-5 text-sm font-medium transition-colors sm:w-[112px]",
                          discordPresenceEnabled
                            ? "border-white bg-white text-black hover:bg-white/90"
                            : "border-white/[0.075] bg-[#111216] text-white/70 hover:bg-white/[0.05] hover:text-white"
                        )}>
                        {discordPresenceEnabled ? "On" : "Off"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* right */}
                <div className="space-y-6">
                  <div className="rounded-[14px] border border-white/[0.075] bg-[#111216] p-5 space-y-3">
                    <div className="flex items-center justify-between gap-4 border-b border-white/[0.075] pb-4">
                      <div>
                        <p className="text-[15px] font-medium text-white">Updates</p>
                        <p className="mt-0.5 text-[12px] text-white/35">Keep xype up to date</p>
                      </div>
                      <span className="text-[12px] text-white/30 font-mono bg-white/[0.04] px-2.5 py-1 rounded-full border border-white/[0.075]">{appVersion ? `v${appVersion}` : ""}</span>
                    </div>

                    {/* Status card */}
                    {updateStatus === "checking" && (
                      <div className="anim-fade flex items-center gap-2.5 px-4 py-3 rounded-xl border border-white/[0.075] bg-white/[0.01]">
                        <PiSpinnerGapBold className="animate-spin text-white/30 shrink-0" />
                        <span className="text-sm text-white/60">Checking for updates…</span>
                      </div>
                    )}

                    {updateStatus === "uptodate" && (
                      <div className="anim-fade flex items-center gap-2.5 px-4 py-3 rounded-xl border border-white/[0.075] bg-white/[0.01]">
                        <PiCheckCircleFill className="text-emerald-500 shrink-0" />
                        <span className="text-sm text-white/60">You're on the latest version.</span>
                      </div>
                    )}

                    {updateStatus === "available" && updateInfo && (
                      <div className="anim-slide-down rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
                        <div className="flex items-start gap-2.5">
                          <PiDownloadSimpleDuotone className="text-emerald-400 text-lg shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-emerald-400">v{updateInfo.version} available</p>
                            {updateInfo.body && (
                              <p className="text-[12px] text-white/50 mt-1 leading-relaxed">{updateInfo.body}</p>
                            )}
                          </div>
                        </div>
                        <button type="button" onClick={doInstallUpdate}
                          className="w-full h-10 rounded-xl bg-white text-sm font-medium text-black transition-colors hover:bg-white/90">
                          Download &amp; Install
                        </button>
                      </div>
                    )}

                    {updateStatus === "downloading" && (
                      <div className="anim-fade rounded-xl border border-white/[0.075] bg-white/[0.01] p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-white/60">Downloading update…</span>
                          <span className="text-[12px] font-mono text-white/30 tabular-nums">{updateProgress}%</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-white/[0.04]">
                          <div
                            className="h-full rounded-full bg-white/40 transition-[width] duration-300"
                            style={{ width: `${updateProgress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {updateStatus === "ready" && (
                      <div className="anim-slide-down rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
                        <div className="flex items-center gap-2.5">
                          <PiCheckCircleFill className="text-emerald-400 shrink-0" />
                          <p className="text-sm text-emerald-400 font-medium">Update installed. Restart to apply.</p>
                        </div>
                        <button type="button" onClick={() => relaunch()}
                          className="w-full h-10 rounded-xl bg-white text-sm font-medium text-black transition-colors hover:bg-white/90 flex items-center justify-center gap-2">
                          <PiArrowCounterClockwiseDuotone className="text-base" />
                          Restart now
                        </button>
                      </div>
                    )}

                    {updateStatus === "error" && (
                      <div className="anim-fade rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3">
                        <p className="text-sm text-destructive">{updateError || "Update check failed. Try again later."}</p>
                      </div>
                    )}

                    {(updateStatus === "idle" || updateStatus === "uptodate" || updateStatus === "error") && (
                      <button type="button" onClick={doCheckUpdate}
                        className="w-full h-10 rounded-xl border border-white/[0.075] bg-[#111216] px-5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white flex items-center justify-center gap-1.5">
                        <PiArrowsClockwiseDuotone className="text-base" />
                        Check for updates
                      </button>
                    )}
                  </div>
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

      {appAccess === false && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="rounded-[20px] border border-white/[0.075] bg-[#111216] p-7 text-center max-w-sm space-y-5 shadow-2xl">
            <div className="space-y-2">
              <p className="text-lg font-medium text-white">Access required</p>
              <p className="text-sm text-white/40 leading-relaxed">
                You must be logged in with an active subscription to use xype.
              </p>
              {accessError && (
                <p className="text-[12px] text-destructive">
                  Access check failed. Log in again or retry in a moment.
                </p>
              )}
            </div>
            <div className="flex gap-3 justify-center">
              <button type="button" onClick={() => openUrl("https://xype.gg/login")}
                className="h-10 rounded-xl bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-white/90"
              >
                Log in
              </button>
              <button type="button" onClick={async () => {
                try {
                  const res = await invoke<{ access: boolean; error?: string }>("check_app_access_detailed");
                  setAppAccess(res.access);
                  setAccessError(res.error || "");
                } catch { setAppAccess(false); setAccessError("Check failed"); }
              }}
                className="h-10 rounded-xl border border-white/[0.075] bg-[#111216] px-5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FFmpeg warning banner ──
function FfmpegWarning({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="anim-slide-down shrink-0 w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.075] bg-white/[0.02] text-left group hover:bg-white/[0.04] transition-colors duration-200">
      <span className="text-white/30">
        <PiWarningCircleDuotone className="text-base shrink-0" />
      </span>
      <span className="text-[13px] text-white/60">
        FFmpeg not configured —{" "}
        <span className="text-white font-medium group-hover:underline underline-offset-4">open Settings</span>
      </span>
    </button>
  );
}

function StatusCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 border-r border-white/[0.055] px-4 py-3 last:border-r-0">
      <p className="text-[10px] font-medium text-white/25">{label}</p>
      <p className="mt-1 truncate text-[12px] font-medium text-white/70 tabular-nums">{value}</p>
    </div>
  );
}

// ── Result banner ──
function ResultBanner({ result }: { result: ProcessResult }) {
  return (
    <div className={cn("anim-slide-up rounded-xl border px-3.5 py-3 text-[13px] transition-all",
      result.success
        ? "border-emerald-400/20 bg-emerald-400/[0.045] text-emerald-300"
        : "border-destructive/20 bg-destructive/[0.045] text-destructive")}>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md anim-fade"
      onClick={onClose}
    >
      <div
        className="anim-scale-in w-[420px] max-h-[90vh] space-y-3 overflow-y-auto rounded-[20px] border border-white/[0.08] bg-[#0d0e11] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.04)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-400/10 flex items-center justify-center shrink-0">
            <PiCheckCircleFill className="text-emerald-400 text-lg" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-sm font-medium text-white">{data.message}</p>
            <p className="text-[11px] font-mono text-white/30 mt-1.5 truncate" title={data.outputPath}>
              {fileName}
            </p>
          </div>
        </div>

        {videoSrc && (
          <div className="rounded-xl overflow-hidden border border-white/[0.08] bg-black">
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
            className="flex-1 h-10 rounded-xl border border-white/[0.08] bg-white/[0.035] px-5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            Open Location
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-10 rounded-xl bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-white/90"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DropZone ──
function DropZone({
  isDragOver,
  onClick,
  label,
  hint,
}: {
  isDragOver: boolean
  onClick: () => void
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex min-h-[260px] w-full flex-1 flex-col items-center justify-center overflow-hidden rounded-[14px] border border-dashed transition-[transform,background-color,border-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.998]',
        isDragOver
          ? 'border-white/[0.18] bg-white/[0.055]'
          : 'border-white/[0.075] bg-[#101115] hover:border-white/[0.12] hover:bg-[#131419]'
      )}
    >
      <div className="absolute inset-x-10 top-0 h-px bg-white/[0.08] opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

      <div className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <PiFilmSlateDuotone className="text-[20px] text-white/70" />
      </div>

      <div className="relative mt-4 text-center">
        <p className="text-[14px] font-medium tracking-[-0.015em] text-white/90">
          {isDragOver ? 'Release to load' : label}
        </p>

        <p className="mt-1.5 max-w-[34ch] text-[12px] leading-5 text-white/35">
          {hint}
        </p>
      </div>
    </button>
  )
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
      className="relative h-10 rounded-xl overflow-visible cursor-pointer"
      style={{ userSelect: "none" }}
    >
      <div className="absolute inset-0 rounded-xl bg-white/[0.04] border border-white/[0.075]" />

      {segments.map((seg) => {
        const inPct = duration > 0 ? (seg.inPoint / duration) * 100 : 0;
        const outPct = duration > 0 ? (seg.outPoint / duration) * 100 : 100;
        return (
          <div key={seg.id}
            className="absolute inset-y-0 bg-white/10 border-x-2 border-white/30 rounded-sm"
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
        <div className="w-px h-full bg-white/60" />
        <div className="absolute top-0 w-2.5 h-2.5 rounded-full bg-white border-2 border-black"
          style={{ transform: "translateY(-30%)" }} />
      </div>
    </div>
  );
}

// ── Header ──
function Header({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode
  title: string
  sub?: string
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#0d0e11]/95 px-6">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.035] text-[17px] text-white/65">
          {icon}
        </div>

        <div>
          <p className="text-[14px] font-medium tracking-[-0.015em] text-white/90">
            {title}
          </p>

          {sub && (
            <p className="mt-0.5 text-[11px] text-white/30">
              {sub}
            </p>
          )}
        </div>
      </div>
    </header>
  )
}

// ── SidebarItem ──
function SidebarItem({
  active,
  collapsed = false,
  onClick,
  icon,
  children,
  disabled = false,
  tooltip,
}: {
  active: boolean
  collapsed?: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
  disabled?: boolean
  tooltip?: string
}) {
  const button = (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      className={cn(
        'group relative flex h-8 w-full items-center rounded-lg px-2 transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.985]',
        disabled
          ? 'cursor-not-allowed text-white/20'
          : active
          ? 'bg-[#15161a] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'text-white/40 hover:bg-white/[0.04] hover:text-white/80'
      )}
    >
      {active && !disabled && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-white/65" />
      )}
      <span className="grid h-5 w-5 place-items-center text-[16px]">
        {icon}
      </span>

      {!collapsed && (
        <span className="ml-2 flex flex-1 items-center justify-between text-[12px] font-medium tracking-[-0.005em]">
          {children}
        </span>
      )}
    </button>
  );

  if (!tooltip) return button;

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={10}
          className="max-w-[220px] rounded-xl border border-white/[0.08] bg-[#111111] px-3 py-2 text-[12px] leading-5 text-white/75 shadow-2xl shadow-black/40"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
