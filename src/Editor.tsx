import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import {
  PiArrowClockwiseDuotone,
  PiCaretDownBold,
  PiCursorDuotone,
  PiFolderOpenDuotone,
  PiFloppyDiskDuotone,
  PiHandPalmDuotone,
  PiMagnifyingGlassDuotone,
  PiMusicNotesDuotone,
  PiPauseFill,
  PiPlayFill,
  PiPlusBold,
  PiScissorsDuotone,
  PiSpinnerGapBold,
  PiTrashDuotone,
  PiVideoCameraDuotone,
  PiExportDuotone,
} from "react-icons/pi";

type MediaKind = "video" | "audio";

interface ProcessResult { success: boolean; message: string; output_path?: string; }

interface EditorAsset {
  id: string;
  path: string;
  name: string;
  src: string;
  duration: number;
  kind: MediaKind;
}

interface EditorClip {
  id: string;
  assetId: string;
  sourcePath: string;
  name: string;
  kind: MediaKind;
  sourceIn: number;
  sourceOut: number;
  start: number;
  layer: number;
  color: string;
}

interface EditorProject {
  app: "xype";
  format: "xype-editor-project";
  version: 1;
  name: string;
  assets: EditorAsset[];
  clips: EditorClip[];
}

interface EditorProps {
  ffmpegPath: string;
  ffmpegValid: boolean | null;
  isDragOver: boolean;
  onOpenSettings: () => void;
  onSuccess: (message: string, outputPath: string) => void;
}

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];
const AUDIO_EXTS = ["mp3", "wav", "aac", "m4a", "flac", "ogg"];
const COLORS = ["#87d6ff", "#9ff2b4", "#ffd166", "#ff9fb2", "#cbb6ff", "#f4a261"];
const LAYERS = [4, 3, 2, 1];

const fmt = (t: number) => {
  if (!Number.isFinite(t) || t < 0) return "0:00.0";
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
};

const nameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extFromPath = (path: string) => (path.split(".").pop() ?? "").toLowerCase();
const clipLen = (clip: EditorClip) => Math.max(0.1, clip.sourceOut - clip.sourceIn);
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const probeDuration = (src: string, kind: MediaKind) => new Promise<number>((resolve) => {
  const media = document.createElement(kind === "video" ? "video" : "audio");
  media.preload = "metadata";
  media.onloadedmetadata = () => resolve(Number.isFinite(media.duration) ? media.duration : 0);
  media.onerror = () => resolve(0);
  media.src = src;
});

export default function Editor({ ffmpegPath, ffmpegValid, isDragOver, onOpenSettings, onSuccess }: EditorProps) {
  const [projectName, setProjectName] = useState("Untitled TikTok");
  const [projectPath, setProjectPath] = useState("");
  const [assets, setAssets] = useState<EditorAsset[]>([]);
  const [clips, setClips] = useState<EditorClip[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [selectedClipId, setSelectedClipId] = useState("");
  const [activeLayer, setActiveLayer] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pendingIn, setPendingIn] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const [draggingAssetId, setDraggingAssetId] = useState("");
  const [draggingClipId, setDraggingClipId] = useState("");
  const [openMenu, setOpenMenu] = useState<"file" | "edit" | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  const selectedAsset = assets.find(asset => asset.id === selectedAssetId) ?? assets[0];
  const selectedClip = clips.find(clip => clip.id === selectedClipId);
  const duration = Math.max(10, ...clips.map(clip => clip.start + clipLen(clip)));
  const sortedClips = useMemo(() => [...clips].sort((a, b) => a.start - b.start || a.layer - b.layer), [clips]);

  const importFiles = useCallback(async (paths: string[]) => {
    const next = paths.filter(path => {
      const ext = extFromPath(path);
      return VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext);
    }).filter(path => !assets.some(asset => asset.path === path));

    const imported = await Promise.all(next.map(async (path) => {
      const ext = extFromPath(path);
      const kind: MediaKind = VIDEO_EXTS.includes(ext) ? "video" : "audio";
      const src = convertFileSrc(path);
      return {
        id: makeId(),
        path,
        name: nameFromPath(path),
        src,
        kind,
        duration: await probeDuration(src, kind),
      };
    }));

    if (imported.length === 0) return;
    setAssets(prev => [...prev, ...imported]);
    setSelectedAssetId(imported[0].id);
    setStatus(`${imported.length} item${imported.length === 1 ? "" : "s"} imported`);
  }, [assets]);

  const pickMedia = async () => {
    const sel = await open({
      multiple: true,
      filters: [{ name: "Video and audio", extensions: [...VIDEO_EXTS, ...AUDIO_EXTS] }],
    });
    if (typeof sel === "string") void importFiles([sel]);
    else if (Array.isArray(sel)) void importFiles(sel);
  };

  const addAssetToTimeline = (asset = selectedAsset, startOverride?: number, layerOverride?: number) => {
    if (!asset) return;
    const targetLayer = layerOverride ?? activeLayer;
    const layerClips = clips.filter(clip => clip.layer === targetLayer);
    const start = layerClips.reduce((max, clip) => Math.max(max, clip.start + clipLen(clip)), 0);
    const id = makeId();
    setClips(prev => [...prev, {
      id,
      assetId: asset.id,
      sourcePath: asset.path,
      name: asset.name,
      kind: asset.kind,
      sourceIn: 0,
      sourceOut: Math.max(0.1, asset.duration || 1),
      start: startOverride ?? start,
      layer: targetLayer,
      color: COLORS[prev.length % COLORS.length],
    }]);
    setSelectedClipId(id);
  };

  const addDraggedAsset = (event: React.DragEvent, start: number, layer: number) => {
    event.preventDefault();
    event.stopPropagation();
    const assetId = event.dataTransfer.getData("application/x-xype-asset") || draggingAssetId;
    const asset = assets.find(item => item.id === assetId);
    if (!asset) return;
    addAssetToTimeline(asset, Math.max(0, start), Math.max(1, Math.min(4, layer)));
    setDraggingAssetId("");
  };

  const splitSelectedClip = () => {
    if (!selectedClip) return;
    const local = currentTime - selectedClip.start;
    if (local <= 0.05 || local >= clipLen(selectedClip) - 0.05) return;
    const splitSource = selectedClip.sourceIn + local;
    const right: EditorClip = {
      ...selectedClip,
      id: makeId(),
      sourceIn: splitSource,
      start: currentTime,
    };
    setClips(prev => prev.map(clip =>
      clip.id === selectedClip.id ? { ...clip, sourceOut: splitSource } : clip
    ).concat(right));
    setSelectedClipId(right.id);
  };

  const markIn = () => setPendingIn(currentTime);
  const markOut = () => {
    if (!selectedAsset || pendingIn === null || currentTime <= pendingIn) return;
    const id = makeId();
    setClips(prev => [...prev, {
      id,
      assetId: selectedAsset.id,
      sourcePath: selectedAsset.path,
      name: selectedAsset.name,
      kind: selectedAsset.kind,
      sourceIn: pendingIn,
      sourceOut: currentTime,
      start: clips.reduce((max, clip) => Math.max(max, clip.start + clipLen(clip)), 0),
      layer: activeLayer,
      color: COLORS[prev.length % COLORS.length],
    }]);
    setPendingIn(null);
    setSelectedClipId(id);
  };

  const replaySelection = () => {
    if (selectedClip) {
      setCurrentTime(selectedClip.start);
      setPlaying(true);
      return;
    }
    if (selectedAsset?.kind === "video" && previewRef.current) {
      previewRef.current.src = selectedAsset.src;
      previewRef.current.currentTime = 0;
      setPlaying(true);
      void previewRef.current.play().catch(() => undefined);
    }
  };

  const removeSelected = () => {
    if (!selectedClipId) return;
    setClips(prev => prev.filter(clip => clip.id !== selectedClipId));
    setSelectedClipId("");
  };

  const nudgeSelected = (delta: number) => {
    if (!selectedClipId) return;
    setClips(prev => prev.map(clip =>
      clip.id === selectedClipId ? { ...clip, start: Math.max(0, clip.start + delta) } : clip
    ));
  };

  const moveClip = (id: string, start: number, layer: number) => {
    setClips(prev => prev.map(clip =>
      clip.id === id ? { ...clip, start: Math.max(0, start), layer: Math.max(1, Math.min(4, layer)) } : clip
    ));
    setSelectedClipId(id);
    setCurrentTime(Math.max(0, start));
  };

  const setSelectedLayer = (layer: number) => {
    if (!selectedClipId) {
      setActiveLayer(layer);
      return;
    }
    setClips(prev => prev.map(clip => clip.id === selectedClipId ? { ...clip, layer } : clip));
  };

  const trimSelected = (edge: "in" | "out", delta: number) => {
    if (!selectedClipId) return;
    setClips(prev => prev.map(clip => {
      if (clip.id !== selectedClipId) return clip;
      if (edge === "in") {
        const nextIn = Math.max(0, Math.min(clip.sourceIn + delta, clip.sourceOut - 0.1));
        return { ...clip, sourceIn: nextIn, start: Math.max(0, clip.start + (nextIn - clip.sourceIn)) };
      }
      return { ...clip, sourceOut: Math.max(clip.sourceIn + 0.1, clip.sourceOut + delta) };
    }));
  };

  const saveProject = async () => {
    const path = projectPath || await save({
      defaultPath: `${projectName.replace(/[\\/:*?"<>|]/g, "-")}.son`,
      filters: [{ name: "Xype Project", extensions: ["son"] }],
    });
    if (!path) return;
    const project: EditorProject = { app: "xype", format: "xype-editor-project", version: 1, name: projectName, assets, clips };
    await invoke("save_editor_project", { path, contents: JSON.stringify(project, null, 2) });
    setProjectPath(path);
    setStatus(`Saved ${nameFromPath(path)}`);
  };

  const loadProject = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Xype Project", extensions: ["son"] }] });
    if (typeof path !== "string") return;
    const contents = await invoke<string>("load_editor_project", { path });
    const project = JSON.parse(contents) as EditorProject;
    setProjectName(project.name || "Untitled TikTok");
    setAssets(project.assets.map(asset => ({ ...asset, src: convertFileSrc(asset.path) })));
    setClips(project.clips);
    setProjectPath(path);
    setSelectedAssetId(project.assets[0]?.id ?? "");
    setSelectedClipId("");
    setStatus(`Opened ${nameFromPath(path)}`);
  };

  const exportProject = async () => {
    if (!ffmpegValid || clips.length === 0) return;
    setProcessing(true);
    setStatus("");
    try {
      const res = await invoke<ProcessResult>("export_editor_project", {
        ffmpegPath,
        projectName,
        clips: sortedClips.map(clip => ({
          inputPath: clip.sourcePath,
          kind: clip.kind,
          start: clip.sourceIn,
          end: clip.sourceOut,
          timelineStart: clip.start,
          layer: clip.layer,
        })),
      });
      if (res.success && res.output_path) onSuccess(res.message, res.output_path);
      else setStatus(res.message);
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    } finally {
      setProcessing(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") void importFiles(event.payload.paths);
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, [importFiles]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const mod = event.ctrlKey || event.metaKey;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying(prev => !prev);
      } else if (event.code === "KeyI") {
        event.preventDefault();
        markIn();
      } else if (event.code === "KeyO") {
        event.preventDefault();
        markOut();
      } else if (event.code === "KeyB") {
        event.preventDefault();
        splitSelectedClip();
      } else if (event.code === "Home") {
        event.preventDefault();
        setCurrentTime(selectedClip?.start ?? 0);
      } else if (event.code === "Enter") {
        event.preventDefault();
        replaySelection();
      } else if (event.code === "Delete" || event.code === "Backspace") {
        event.preventDefault();
        removeSelected();
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        selectedClipId ? nudgeSelected(event.shiftKey ? -1 : -0.1) : setCurrentTime(t => Math.max(0, t - (event.shiftKey ? 1 : 0.1)));
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        selectedClipId ? nudgeSelected(event.shiftKey ? 1 : 0.1) : setCurrentTime(t => Math.min(duration, t + (event.shiftKey ? 1 : 0.1)));
      } else if (event.code === "BracketLeft") {
        event.preventDefault();
        trimSelected("in", event.shiftKey ? -0.1 : 0.1);
      } else if (event.code === "BracketRight") {
        event.preventDefault();
        trimSelected("out", event.shiftKey ? 0.1 : -0.1);
      } else if (mod && event.code === "KeyS") {
        event.preventDefault();
        void saveProject();
      } else if (mod && event.code === "KeyO") {
        event.preventDefault();
        void loadProject();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setCurrentTime(t => Math.min(duration, t + 0.05)), 50);
    return () => window.clearInterval(id);
  }, [playing, duration]);

  useEffect(() => {
    const current = sortedClips.find(clip => clip.kind === "video" && currentTime >= clip.start && currentTime <= clip.start + clipLen(clip));
    if (!previewRef.current) return;
    if (!current) {
      previewRef.current.pause();
      previewRef.current.removeAttribute("src");
      previewRef.current.load();
      if (playing && currentTime >= duration) setPlaying(false);
      return;
    }
    const asset = assets.find(item => item.id === current.assetId);
    if (!asset) return;
    if (previewRef.current.src !== asset.src) previewRef.current.src = asset.src;
    const targetTime = current.sourceIn + currentTime - current.start;
    if (Math.abs(previewRef.current.currentTime - targetTime) > 0.15) previewRef.current.currentTime = targetTime;
    if (playing) void previewRef.current.play().catch(() => undefined);
    else previewRef.current.pause();
  }, [assets, currentTime, duration, playing, sortedClips]);

  return (
    <main className="relative flex-1 overflow-hidden bg-[#191919]">
      {isDragOver && <div className="pointer-events-none absolute inset-2 z-40 border border-dashed border-[#4d8fe8] bg-[#4d8fe8]/10" />}
      <div className="flex h-8 items-center gap-1 border-b border-black bg-[#111216] px-2 text-[#b8b8b8]">
        <MenuButton label="File" open={openMenu === "file"} onOpen={() => setOpenMenu(openMenu === "file" ? null : "file")}
          items={[
            { label: "Import Media", shortcut: "Ctrl+I", icon: <PiPlusBold />, action: pickMedia },
            { label: "Open Project", shortcut: "Ctrl+O", icon: <PiFolderOpenDuotone />, action: loadProject },
            { label: "Save Project", shortcut: "Ctrl+S", icon: <PiFloppyDiskDuotone />, action: () => void saveProject() },
            { label: "Export TikTok", shortcut: "", icon: <PiExportDuotone />, action: exportProject },
          ]} />
        <MenuButton label="Edit" open={openMenu === "edit"} onOpen={() => setOpenMenu(openMenu === "edit" ? null : "edit")}
          items={[
            { label: "Split Layer", shortcut: "B", icon: <PiScissorsDuotone />, action: splitSelectedClip },
            { label: "Delete Layer", shortcut: "Del", icon: <PiTrashDuotone />, action: removeSelected },
            { label: "Replay Selection", shortcut: "Enter", icon: <PiArrowClockwiseDuotone />, action: replaySelection },
          ]} />
        <span className="mx-1 h-4 w-px bg-white/10" />
        <ToolGlyph active icon={<PiCursorDuotone />} title="Selection" />
        <ToolGlyph icon={<PiHandPalmDuotone />} title="Hand" />
        <ToolGlyph icon={<PiMagnifyingGlassDuotone />} title="Zoom" />
        <ToolGlyph icon={<PiScissorsDuotone />} title="Blade / Split" onClick={splitSelectedClip} />
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          <span className="border border-white/[0.075] bg-white/[0.035] px-2 py-0.5 text-white/65">Xype Editor</span>
          <span className="text-white/35">{projectPath ? nameFromPath(projectPath) : "Unsaved Project"}</span>
        </div>
      </div>
      <div className="grid h-[calc(100%-2rem)] grid-cols-[232px_minmax(0,1fr)_248px] grid-rows-[minmax(0,1fr)_236px]">
        <aside className="border-r border-white/[0.075] bg-[#0d0e11]"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).map(file => (file as File & { path?: string }).path).filter((path): path is string => !!path);
            if (files.length > 0) void importFiles(files);
            setDraggingAssetId("");
          }}>
          <PanelHeader title="Project" value={projectPath ? nameFromPath(projectPath) : "unsaved"} />
          <div className="flex gap-1 border-b border-white/[0.075] p-2">
            <IconButton title="Import" onClick={pickMedia}><PiPlusBold /></IconButton>
            <IconButton title="Open .son" onClick={loadProject}><PiFolderOpenDuotone /></IconButton>
            <IconButton title="Save .son" onClick={() => void saveProject()}><PiFloppyDiskDuotone /></IconButton>
          </div>
          <div className="space-y-1 p-2">
            {assets.map(asset => (
              <button key={asset.id} type="button" draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-xype-asset", asset.id);
                  event.dataTransfer.setData("text/plain", asset.id);
                  event.dataTransfer.effectAllowed = "copy";
                  setDraggingAssetId(asset.id);
                }}
                onDragEnd={() => setDraggingAssetId("")}
                onClick={() => setSelectedAssetId(asset.id)}
                onDoubleClick={() => addAssetToTimeline(asset)}
                className={cn("group flex w-full cursor-grab items-center gap-2 border px-2 py-1.5 text-left active:cursor-grabbing", selectedAssetId === asset.id ? "border-white/20 bg-white/[0.08]" : "border-white/[0.055] bg-white/[0.025] hover:bg-white/[0.05]")}>
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-black/30 text-white/50">{asset.kind === "video" ? <PiVideoCameraDuotone /> : <PiMusicNotesDuotone />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-white/75">{asset.name}</span>
                  <span className="font-mono text-[10px] text-white/30">{fmt(asset.duration)}</span>
                </span>
              </button>
            ))}
            {!assets.length && (
              <div className="mt-3 border border-dashed border-[#3a3a3a] bg-[#151515] p-4 text-center text-[12px] text-[#858585]">
                Drop footage here, then drag it into Composition or Timeline.
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col border-r border-white/[0.075] bg-black">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.075] bg-[#0d0e11] px-3">
            <input value={projectName} onChange={e => setProjectName(e.target.value)}
              className="h-7 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-white/80 outline-none" />
            <span className="bg-white px-1.5 py-0.5 text-[10px] font-bold text-black">BETA</span>
          </div>
          <div className={cn("relative flex min-h-0 flex-1 items-center justify-center", draggingAssetId && "outline outline-1 outline-[#4d8fe8]/70")}
            onDragOver={(event) => {
              if (draggingAssetId) event.preventDefault();
            }}
            onDrop={(event) => addDraggedAsset(event, currentTime, activeLayer)}>
            <video ref={previewRef} muted playsInline preload="metadata" disablePictureInPicture className="h-full w-full object-contain" />
            {!assets.length && (
              <div className="absolute grid grid-cols-2 gap-16">
                <button type="button" onClick={pickMedia}
                  className="grid h-28 w-40 place-items-center border border-[#3a3a3a] bg-[#0c0c0c] text-[13px] text-[#c8c8c8] hover:border-[#4d8fe8] hover:text-white">
                  New Composition
                </button>
                <button type="button" onClick={pickMedia}
                  className="grid h-28 w-40 place-items-center border border-[#3a3a3a] bg-[#0c0c0c] text-center text-[13px] text-[#c8c8c8] hover:border-[#4d8fe8] hover:text-white">
                  New Composition<br />From Footage
                </button>
              </div>
            )}
            {assets.length > 0 && clips.length === 0 && (
              <div className="pointer-events-none absolute bottom-5 border border-dashed border-[#4d8fe8]/60 bg-[#0c0c0c]/90 px-4 py-2 text-[12px] text-[#b8cfff]">
                Drag footage from Project into this Composition or the Timeline.
              </div>
            )}
          </div>
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-t border-white/[0.075] bg-[#0d0e11] px-2">
            <IconButton title="Play/Pause" onClick={() => setPlaying(prev => !prev)}>{playing ? <PiPauseFill /> : <PiPlayFill />}</IconButton>
            <IconButton title="Replay selected clip (Enter)" onClick={replaySelection}><PiArrowClockwiseDuotone /></IconButton>
            <IconButton title="Split selected (B)" onClick={splitSelectedClip}><PiScissorsDuotone /></IconButton>
            <IconButton title="Delete selected" onClick={removeSelected}><PiTrashDuotone /></IconButton>
            <button type="button" onClick={markIn} className="h-7 border border-white/[0.075] px-2.5 text-[11px] text-white/60 hover:text-white">I</button>
            <button type="button" onClick={markOut} className="h-7 border border-white/[0.075] px-2.5 text-[11px] text-white/60 hover:text-white">O</button>
            <span className="font-mono text-[12px] text-white/35">{fmt(currentTime)}</span>
          </div>
        </section>

        <aside className="bg-[#0d0e11]">
          <PanelHeader title="Effects Controls" value={selectedClip ? selectedClip.name : "no selection"} />
          <div className="space-y-3 p-3">
            {!ffmpegValid && (
              <button type="button" onClick={onOpenSettings} className="w-full rounded-lg border border-amber-400/25 bg-amber-400/10 p-3 text-left text-[12px] text-amber-200">
                FFmpeg is required for export. Open Settings.
              </button>
            )}
            <div className="border border-white/[0.075] bg-white/[0.025] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">Layer target</p>
              <div className="mt-2 grid grid-cols-4 gap-1">
                {[1, 2, 3, 4].map(layer => (
                  <button key={layer} type="button" onClick={() => setSelectedLayer(layer)}
                    className={cn("h-7 text-[12px]", (selectedClip?.layer ?? activeLayer) === layer ? "bg-white text-black" : "bg-white/[0.05] text-white/45 hover:text-white")}>
                    {layer}
                  </button>
                ))}
              </div>
            </div>
            {selectedClip && (
              <div className="border border-white/[0.075] bg-white/[0.025] p-3 text-[12px] text-white/55">
                <InspectorRow label="Start" value={fmt(selectedClip.start)} />
                <InspectorRow label="In" value={fmt(selectedClip.sourceIn)} />
                <InspectorRow label="Out" value={fmt(selectedClip.sourceOut)} />
                <InspectorRow label="Layer" value={`${selectedClip.layer}`} />
                <div className="mt-2 grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => trimSelected("in", 0.1)} className="h-7 bg-white/[0.05] text-[11px] text-white/55 hover:text-white">Trim In</button>
                  <button type="button" onClick={() => trimSelected("out", -0.1)} className="h-7 bg-white/[0.05] text-[11px] text-white/55 hover:text-white">Trim Out</button>
                </div>
              </div>
            )}
            <button type="button" onClick={exportProject} disabled={!ffmpegValid || clips.length === 0 || processing}
              className={cn("h-10 w-full rounded-lg text-[13px] font-medium", ffmpegValid && clips.length > 0 && !processing ? "bg-white text-black hover:bg-white/90" : "bg-white/[0.05] text-white/20")}>
              {processing ? <span className="flex items-center justify-center gap-2"><PiSpinnerGapBold className="animate-spin" />Exporting</span> : "Export TikTok"}
            </button>
            {status && <p className="rounded-lg border border-white/[0.075] bg-white/[0.025] p-3 text-[12px] text-white/45">{status}</p>}
          </div>
        </aside>

        <section className="col-span-3 border-t border-white/[0.075] bg-[#0d0e11]">
          <Timeline clips={clips} duration={duration} currentTime={currentTime} selectedClipId={selectedClipId}
            draggingAssetId={draggingAssetId}
            draggingClipId={draggingClipId}
            onSelect={(id) => {
              setSelectedClipId(id);
              const clip = clips.find(item => item.id === id);
              if (clip) setCurrentTime(clip.start);
            }}
            onSeek={setCurrentTime}
            onNudge={nudgeSelected}
            onDropAsset={addDraggedAsset}
            onMoveClip={moveClip}
            onClipDragStart={setDraggingClipId}
            onClipDragEnd={() => setDraggingClipId("")} />
        </section>
      </div>
    </main>
  );
}

function Timeline({ clips, duration, currentTime, selectedClipId, draggingAssetId, draggingClipId, onSelect, onSeek, onNudge, onDropAsset, onMoveClip, onClipDragStart, onClipDragEnd }: {
  clips: EditorClip[];
  duration: number;
  currentTime: number;
  selectedClipId: string;
  draggingAssetId: string;
  draggingClipId: string;
  onSelect: (id: string) => void;
  onSeek: (time: number) => void;
  onNudge: (delta: number) => void;
  onDropAsset: (event: React.DragEvent, start: number, layer: number) => void;
  onMoveClip: (id: string, start: number, layer: number) => void;
  onClipDragStart: (id: string) => void;
  onClipDragEnd: () => void;
}) {
  const width = Math.max(duration, 10);
  return (
    <div className="grid h-full grid-cols-[136px_minmax(0,1fr)] text-[11px]">
      <div className="border-r border-white/[0.075] bg-[#0d0e11]">
        <div className="flex h-7 items-center border-b border-white/[0.075] px-3 text-white/35">Layer Name</div>
        {LAYERS.map(layer => (
          <div key={layer} className="grid h-12 grid-cols-[24px_1fr] items-center border-b border-white/[0.055] px-2 text-white/45">
            <span className="text-[#606060]">{layer}</span>
            <span>Layer {layer}</span>
          </div>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <div className="relative min-w-full" style={{ width: `${width * 72}px` }}>
          <div className="relative h-7 border-b border-white/[0.075] bg-[#111216]" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, ((e.clientX - rect.left) / rect.width) * duration));
          }}>
            {Array.from({ length: Math.ceil(duration) + 1 }).map((_, i) => (
              <div key={i} className="absolute top-0 h-full border-l border-white/[0.06] pl-1 pt-1.5 font-mono text-[10px] text-white/25" style={{ left: `${(i / duration) * 100}%` }}>{i}s</div>
            ))}
          </div>
          <div
            className={cn("relative h-48", (draggingAssetId || draggingClipId) && "bg-[#4d8fe8]/5")}
            onDragOver={(event) => {
              if (draggingAssetId || draggingClipId) event.preventDefault();
            }}
            onDrop={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const start = ((event.clientX - rect.left) / rect.width) * duration;
              const row = Math.max(0, Math.min(3, Math.floor((event.clientY - rect.top) / 48)));
              const layer = 4 - row;
              const clipId = event.dataTransfer.getData("application/x-xype-clip") || draggingClipId;
              if (clipId) {
                event.preventDefault();
                event.stopPropagation();
                onMoveClip(clipId, start, layer);
                onClipDragEnd();
                return;
              }
              onDropAsset(event, start, layer);
            }}>
            {LAYERS.map(layer => <div key={layer} className="h-12 border-b border-white/[0.055] bg-[linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[length:72px_100%]" />)}
            {clips.map(clip => (
              <button key={clip.id} type="button" onClick={() => onSelect(clip.id)} onDoubleClick={() => onNudge(0.25)}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-xype-clip", clip.id);
                  event.dataTransfer.effectAllowed = "move";
                  onClipDragStart(clip.id);
                  onSelect(clip.id);
                }}
                onDragEnd={onClipDragEnd}
                className={cn("absolute h-9 overflow-hidden border px-2 text-left shadow-lg", selectedClipId === clip.id ? "border-white bg-white/20" : "border-black/35")}
                style={{
                  left: `${(clip.start / duration) * 100}%`,
                  top: `${(4 - clip.layer) * 48 + 6}px`,
                  width: `${(clipLen(clip) / duration) * 100}%`,
                  backgroundColor: `${clip.color}26`,
                  color: clip.color,
                }}>
                <span className="block truncate text-[11px] font-semibold">{clip.name}</span>
                <span className="font-mono text-[10px] opacity-70">{fmt(clipLen(clip))}</span>
              </button>
            ))}
            <div className="pointer-events-none absolute top-0 h-full w-px bg-white/80" style={{ left: `${(currentTime / duration) * 100}%` }}>
              <div className="absolute -left-1.5 -top-1 h-3 w-3 rotate-45 bg-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelHeader({ title, value }: { title: string; value: string }) {
  return (
    <div className="border-b border-white/[0.075] px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/35">{title}</p>
      <p className="mt-0.5 truncate text-[12px] text-white/55">{value}</p>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="grid h-7 w-7 place-items-center border border-white/[0.075] bg-white/[0.035] text-white/55 hover:bg-white/[0.07] hover:text-white">
      {children}
    </button>
  );
}

function ToolGlyph({ icon, title, active = false, onClick }: { icon: React.ReactNode; title: string; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={cn("grid h-6 w-7 place-items-center border border-transparent text-[15px]", active ? "border-white/15 bg-white/[0.08] text-white" : "text-white/45 hover:border-white/[0.075] hover:bg-white/[0.04] hover:text-white")}>
      {icon}
    </button>
  );
}

function MenuButton({ label, open, onOpen, items }: {
  label: string;
  open: boolean;
  onOpen: () => void;
  items: Array<{ label: string; shortcut: string; icon: React.ReactNode; action: () => void }>;
}) {
  return (
    <div className="relative">
      <button type="button" onClick={onOpen}
        className={cn("flex h-6 items-center gap-1 px-2 text-[12px]", open ? "bg-white/[0.08] text-white" : "text-white/55 hover:bg-white/[0.04] hover:text-white")}>
        {label}
        <PiCaretDownBold className="text-[9px] opacity-50" />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-50 w-52 border border-white/[0.075] bg-[#111216] p-1 shadow-2xl shadow-black/50">
          {items.map(item => (
            <button key={item.label} type="button" onClick={() => { onOpen(); item.action(); }}
              className="flex h-8 w-full items-center gap-2 px-2 text-left text-[12px] text-white/65 hover:bg-white/[0.06] hover:text-white">
              <span className="grid w-4 place-items-center text-[15px] text-white/45">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.shortcut && <span className="font-mono text-[10px] text-white/25">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between border-b border-white/[0.055] py-1.5 last:border-b-0"><span className="text-white/35">{label}</span><span className="font-mono text-white/65">{value}</span></div>;
}
