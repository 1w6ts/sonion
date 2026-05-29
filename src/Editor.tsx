import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import {
  PiArrowClockwiseDuotone,
  PiCaretLeftFill,
  PiCaretRightFill,
  PiCheckCircleFill,
  PiExportDuotone,
  PiFolderOpenDuotone,
  PiFloppyDiskDuotone,
  PiPauseFill,
  PiPlayFill,
  PiScissorsDuotone,
  PiSpinnerGapBold,
  PiVideoCameraDuotone,
  PiWarningCircleDuotone,
} from "react-icons/pi";

interface ProcessResult { success: boolean; message: string; output_path?: string; }

interface CutSegment {
  id: string;
  name: string;
  start: number;
  end: number;
}

interface CutProject {
  app: "xype";
  format: "xype-lossless-cut-project";
  version: 1;
  name: string;
  inputPath: string;
  segments: CutSegment[];
}

interface EditorProps {
  ffmpegPath: string;
  ffmpegValid: boolean | null;
  isDragOver: boolean;
  onOpenSettings: () => void;
  onSuccess: (message: string, outputPath: string) => void;
}

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v"];
const MIN_SEGMENT = 0.05;

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const nameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extFromPath = (path: string) => (path.split(".").pop() ?? "").toLowerCase();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const fmt = (time: number, precise = true) => {
  if (!Number.isFinite(time) || time < 0) return precise ? "00:00:00.000" : "0:00";
  const hours = Math.floor(time / 3600);
  const minutes = Math.floor((time % 3600) / 60);
  const seconds = Math.floor(time % 60);
  const millis = Math.floor((time % 1) * 1000);
  if (!precise) return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};

const parseTime = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (!trimmed.includes(":")) return Number(trimmed) || 0;
  const parts = trimmed.split(":").map(Number).filter(Number.isFinite);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(trimmed) || 0;
};

const probeDuration = (src: string) => new Promise<number>((resolve) => {
  const media = document.createElement("video");
  media.preload = "metadata";
  media.onloadedmetadata = () => resolve(Number.isFinite(media.duration) ? media.duration : 0);
  media.onerror = () => resolve(0);
  media.src = src;
});

export default function Editor({ ffmpegPath, ffmpegValid, isDragOver, onOpenSettings, onSuccess }: EditorProps) {
  const [projectName, setProjectName] = useState("Untitled cut");
  const [projectPath, setProjectPath] = useState("");
  const [inputPath, setInputPath] = useState("");
  const [source, setSource] = useState("");
  const [duration, setDuration] = useState(0);
  const [segments, setSegments] = useState<CutSegment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [markIn, setMarkIn] = useState(0);
  const [markOut, setMarkOut] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const selectedSegment = segments.find(segment => segment.id === selectedSegmentId);
  const sortedSegments = useMemo(() => [...segments].sort((a, b) => a.start - b.start || a.end - b.end), [segments]);
  const totalKept = useMemo(() => segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0), [segments]);
  const canExport = Boolean(ffmpegValid && inputPath && segments.length > 0 && !processing);

  const resetInput = () => {
    setInputPath("");
    setSource("");
    setDuration(0);
    setSegments([]);
    setSelectedSegmentId("");
    setCurrentTime(0);
    setMarkIn(0);
    setMarkOut(0);
    setPlaying(false);
    setProjectPath("");
    setProjectName("Untitled cut");
    setStatus("");
  };

  const updateSelectedRange = (start: number, end: number) => {
    if (!selectedSegmentId) return;
    setSegments(prev => prev.map(segment => segment.id === selectedSegmentId ? { ...segment, start, end } : segment));
  };

  const updateMarkIn = (time: number) => {
    const next = clamp(time, 0, Math.max(0, markOut - MIN_SEGMENT));
    setMarkIn(next);
    updateSelectedRange(next, markOut);
  };

  const updateMarkOut = (time: number) => {
    const next = clamp(time, markIn + MIN_SEGMENT, duration);
    setMarkOut(next);
    updateSelectedRange(markIn, next);
  };

  const loadInput = useCallback(async (path: string) => {
    const ext = extFromPath(path);
    if (!VIDEO_EXTS.includes(ext)) {
      setStatus("Unsupported file type.");
      return;
    }

    const src = convertFileSrc(path);
    const probedDuration = await probeDuration(src);
    const end = Math.max(probedDuration, MIN_SEGMENT);
    const wholeFile: CutSegment = { id: makeId(), name: "Segment 1", start: 0, end };

    setInputPath(path);
    setSource(src);
    setDuration(end);
    setCurrentTime(0);
    setMarkIn(0);
    setMarkOut(end);
    setSegments([wholeFile]);
    setSelectedSegmentId(wholeFile.id);
    setProjectName(nameFromPath(path).replace(/\.[^.]+$/, ""));
    setProjectPath("");
    setStatus(`Loaded ${nameFromPath(path)}`);
  }, []);

  const pickVideo = async () => {
    const selection = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTS }],
    });
    if (typeof selection === "string") void loadInput(selection);
  };

  const addSegment = () => {
    if (!inputPath || markOut <= markIn + MIN_SEGMENT) return;
    const id = makeId();
    setSegments(prev => [...prev, {
      id,
      name: `Segment ${prev.length + 1}`,
      start: clamp(markIn, 0, duration),
      end: clamp(markOut, MIN_SEGMENT, duration),
    }]);
    setSelectedSegmentId(id);
  };

  const replaceSelectedWithMarks = () => {
    if (!selectedSegmentId || markOut <= markIn + MIN_SEGMENT) return;
    setSegments(prev => prev.map(segment => segment.id === selectedSegmentId ? {
      ...segment,
      start: clamp(markIn, 0, duration),
      end: clamp(markOut, MIN_SEGMENT, duration),
    } : segment));
  };

  const splitAtPlayhead = () => {
    if (!selectedSegment) return;
    if (currentTime <= selectedSegment.start + MIN_SEGMENT || currentTime >= selectedSegment.end - MIN_SEGMENT) return;
    const left: CutSegment = { ...selectedSegment, end: currentTime };
    const right: CutSegment = { ...selectedSegment, id: makeId(), name: `Segment ${segments.length + 1}`, start: currentTime };
    setSegments(prev => prev.flatMap(segment => segment.id === selectedSegment.id ? [left, right] : [segment]));
    setSelectedSegmentId(right.id);
    setMarkIn(right.start);
    setMarkOut(right.end);
  };

  const removeSelected = () => {
    if (!selectedSegmentId) return;
    setSegments(prev => prev.filter(segment => segment.id !== selectedSegmentId));
    setSelectedSegmentId("");
  };

  const selectSegment = (segment: CutSegment) => {
    setSelectedSegmentId(segment.id);
    setMarkIn(segment.start);
    setMarkOut(segment.end);
    seek(segment.start);
  };

  const seek = (time: number) => {
    const next = clamp(time, 0, duration || 0);
    setCurrentTime(next);
    if (videoRef.current && Math.abs(videoRef.current.currentTime - next) > 0.005) {
      videoRef.current.currentTime = next;
    }
  };

  const jump = (delta: number) => seek(currentTime + delta);
  const setInAtPlayhead = () => updateMarkIn(currentTime);
  const setOutAtPlayhead = () => updateMarkOut(currentTime);

  const saveProject = async () => {
    if (!inputPath) return;
    const path = projectPath || await save({
      defaultPath: `${projectName.replace(/[\\/:*?"<>|]/g, "-")}.son`,
      filters: [{ name: "Xype Cut Project", extensions: ["son"] }],
    });
    if (!path) return;
    const project: CutProject = { app: "xype", format: "xype-lossless-cut-project", version: 1, name: projectName, inputPath, segments };
    await invoke("save_editor_project", { path, contents: JSON.stringify(project, null, 2) });
    setProjectPath(path);
    setStatus(`Saved ${nameFromPath(path)}`);
  };

  const loadProject = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Xype Project", extensions: ["son"] }] });
    if (typeof path !== "string") return;
    const contents = await invoke<string>("load_editor_project", { path });
    const project = JSON.parse(contents) as CutProject;
    if (project.format !== "xype-lossless-cut-project") {
      setStatus("This editor now opens lossless cut projects only.");
      return;
    }
    const src = convertFileSrc(project.inputPath);
    const probedDuration = await probeDuration(src);
    setProjectName(project.name || "Untitled cut");
    setProjectPath(path);
    setInputPath(project.inputPath);
    setSource(src);
    setDuration(Math.max(probedDuration, ...project.segments.map(segment => segment.end), MIN_SEGMENT));
    setSegments(project.segments);
    setSelectedSegmentId(project.segments[0]?.id ?? "");
    setMarkIn(project.segments[0]?.start ?? 0);
    setMarkOut(project.segments[0]?.end ?? probedDuration);
    setCurrentTime(project.segments[0]?.start ?? 0);
    setStatus(`Opened ${nameFromPath(path)}`);
  };

  const exportSegments = async () => {
    if (!canExport) return;
    setProcessing(true);
    setStatus("");
    try {
      const res = await invoke<ProcessResult>("export_segments", {
        ffmpegPath,
        inputPath,
        segments: sortedSegments.map(segment => ({ start: segment.start, end: segment.end })),
      });
      if (res.success && res.output_path) onSuccess(res.message, res.output_path);
      else setStatus(res.message);
    } catch (error) {
      setStatus(`Export failed: ${error}`);
    } finally {
      setProcessing(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths[0]) void loadInput(event.payload.paths[0]);
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, [loadInput]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onEnded = () => setPlaying(false);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
    };
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, [playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const mod = event.ctrlKey || event.metaKey;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying(prev => !prev);
      } else if (event.code === "KeyI") {
        event.preventDefault();
        setInAtPlayhead();
      } else if (event.code === "KeyO") {
        event.preventDefault();
        setOutAtPlayhead();
      } else if (event.code === "KeyB") {
        event.preventDefault();
        splitAtPlayhead();
      } else if (event.code === "KeyA") {
        event.preventDefault();
        addSegment();
      } else if (event.code === "Delete" || event.code === "Backspace") {
        event.preventDefault();
        removeSelected();
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        jump(event.shiftKey ? -1 : -0.04);
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        jump(event.shiftKey ? 1 : 0.04);
      } else if (mod && event.code === "KeyO") {
        event.preventDefault();
        void loadProject();
      } else if (mod && event.code === "KeyS") {
        event.preventDefault();
        void saveProject();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <main className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-[#0b0c0e] text-white">
      {isDragOver && <div className="pointer-events-none absolute inset-3 z-40 rounded-[16px] border border-dashed border-white/35 bg-white/10" />}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="relative m-3 mb-0 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[16px] border border-white/[0.075] bg-black">
          <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-xl border border-white/[0.075] bg-[#111216]/92 p-1 shadow-xl shadow-black/30 backdrop-blur-xl">
            <button type="button" onClick={pickVideo} className="lc-tool-button"><PiFolderOpenDuotone />Open</button>
            <button type="button" onClick={() => void loadProject()} className="lc-tool-button"><PiFolderOpenDuotone />Project</button>
            <button type="button" onClick={() => void saveProject()} disabled={!inputPath} className="lc-tool-button disabled:opacity-30"><PiFloppyDiskDuotone />Save</button>
            <input value={projectName} onChange={event => setProjectName(event.target.value)}
              className="ml-1 h-7 w-56 min-w-0 rounded-lg border border-white/[0.075] bg-black/25 px-2 text-[12px] font-medium text-white/70 outline-none" />
          </div>

            {source ? (
              <video ref={videoRef} src={source} playsInline preload="metadata" disablePictureInPicture
                onLoadedMetadata={(event) => {
                  const next = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : duration;
                  const nextDuration = Math.max(next, MIN_SEGMENT);
                  setDuration(nextDuration);
                  if (markOut <= MIN_SEGMENT) {
                    setMarkIn(0);
                    setMarkOut(nextDuration);
                    updateSelectedRange(0, nextDuration);
                  }
                }}
                className="h-full w-full object-contain" />
            ) : (
              <button type="button" onClick={pickVideo}
                className="grid h-44 w-[360px] place-items-center rounded-[14px] border border-dashed border-white/20 bg-white/[0.025] text-center text-[13px] text-white/55 hover:border-white/40 hover:text-white">
                <span>
                  <PiVideoCameraDuotone className="mx-auto mb-3 text-4xl text-white/70" />
                  Drop a video or open one
                </span>
              </button>
            )}
        </div>

          <Timeline
            duration={duration}
            currentTime={currentTime}
            markIn={markIn}
            markOut={markOut}
            segments={segments}
            selectedSegmentId={selectedSegmentId}
            onSeek={seek}
            onSelect={selectSegment}
            onSetMarkIn={updateMarkIn}
            onSetMarkOut={updateMarkOut}
          />

        <div className="relative flex h-[78px] shrink-0 items-center justify-center bg-[#0b0c0e]">
          <div className="absolute left-3 bottom-3 flex items-center gap-2 text-[12px] text-white/85">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-white/90 text-black text-[11px]">i</span>
            <span className="text-white/45">Space plays · I/O marks · arrows step</span>
          </div>
          <div className="flex items-center gap-2">
            <TransportButton title="Set in" onClick={setInAtPlayhead} disabled={!inputPath}>I</TransportButton>
            <IconButton title="Back 1 frame" onClick={() => jump(-0.04)}><PiCaretLeftFill /></IconButton>
            <button type="button" title="Play/Pause" onClick={() => setPlaying(prev => !prev)}
              onMouseDown={(event) => event.preventDefault()}
              className="grid h-11 w-11 place-items-center rounded-full bg-white text-xl text-black shadow-lg shadow-black/30 hover:bg-white/90">
              {playing ? <PiPauseFill /> : <PiPlayFill className="translate-x-0.5" />}
            </button>
            <IconButton title="Forward 1 frame" onClick={() => jump(0.04)}><PiCaretRightFill /></IconButton>
            <TransportButton title="Set out" onClick={setOutAtPlayhead} disabled={!inputPath}>O</TransportButton>
          </div>
          <div className="absolute right-3 bottom-3 flex items-center gap-1.5">
            {source && <IconButton title="Close video" onClick={resetInput}>X</IconButton>}
            <IconButton title="Replay selection" onClick={() => seek(selectedSegment?.start ?? markIn)}><PiArrowClockwiseDuotone /></IconButton>
            <IconButton title="Split selected" onClick={splitAtPlayhead}><PiScissorsDuotone /></IconButton>
          </div>
        </div>
      </section>

      <aside className="m-3 ml-0 flex w-[244px] shrink-0 flex-col overflow-hidden rounded-[16px] border border-white/[0.075] bg-[#111216]">
        <div className="flex h-10 items-center justify-between border-b border-white/[0.075] px-3">
          <p className="text-[13px] font-semibold text-white">Segments to export:</p>
          <button type="button" onClick={removeSelected} disabled={!selectedSegment} className="grid h-7 w-7 place-items-center text-xl text-white/55 hover:text-white disabled:opacity-25">×</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sortedSegments.map((segment, index) => (
            <button key={segment.id} type="button" onClick={() => selectSegment(segment)}
              className={cn("mb-1.5 w-full rounded-lg border p-2 text-left", selectedSegmentId === segment.id ? "border-white/25 bg-white/[0.08]" : "border-white/[0.075] bg-white/[0.025] hover:bg-white/[0.045]")}>
              <span className="flex items-center gap-1.5">
                <span className="grid h-5 min-w-5 place-items-center rounded-md border border-white/10 bg-white/90 px-1 text-[11px] font-bold text-black">{index + 1}</span>
                <span className="font-mono text-[11px] font-semibold text-white">{fmt(segment.start)} - {fmt(segment.end)}</span>
              </span>
              <span className="mt-1 block text-[11px] leading-4 text-white/85">Duration {fmt(segment.end - segment.start)}</span>
              <span className="block text-[11px] text-white/70">{Math.round((segment.end - segment.start) * 1000)} ms</span>
            </button>
          ))}
          {!segments.length && (
            <div className="rounded-[3px] border border-dashed border-white/20 p-3 text-[12px] leading-5 text-white/45">
              Set I and O, then add a segment.
            </div>
          )}
        </div>

        <div className="border-t border-white/[0.075] p-2">
          <div className="grid grid-cols-2 gap-1.5">
            <TimeField label="I" value={markIn} max={Math.max(0, markOut - MIN_SEGMENT)} onChange={updateMarkIn} />
            <TimeField label="O" value={markOut} min={markIn + MIN_SEGMENT} max={duration} onChange={updateMarkOut} />
            <button type="button" onClick={addSegment} disabled={!inputPath || markOut <= markIn + MIN_SEGMENT}
              onMouseDown={(event) => event.preventDefault()}
              className="h-8 rounded-lg bg-white/[0.08] text-xl font-bold text-white hover:bg-white/[0.13] disabled:opacity-30">
              +
            </button>
            <button type="button" onClick={replaceSelectedWithMarks} disabled={!selectedSegment}
              onMouseDown={(event) => event.preventDefault()}
              className="h-8 rounded-lg bg-white/[0.08] text-[13px] font-bold text-white hover:bg-white/[0.13] disabled:opacity-30">
              ✓
            </button>
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-[12px]">
            <span className="text-white/75">Segments total:</span>
            <span className="font-mono text-white">{fmt(totalKept)}</span>
          </div>

          {!ffmpegValid && (
            <button type="button" onClick={onOpenSettings} className="mt-2 flex w-full items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 p-2 text-left text-[12px] text-amber-200">
              <PiWarningCircleDuotone className="text-base" />
              FFmpeg required
            </button>
          )}
          {status && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-white/[0.075] bg-white/[0.025] p-2 text-[11px] text-white/62">
              <PiCheckCircleFill className="mt-0.5 shrink-0 text-white/70" />
              <span>{status}</span>
            </div>
          )}
          <button type="button" onClick={() => void exportSegments()} disabled={!canExport}
            className={cn("mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[14px] font-semibold", canExport ? "bg-white text-black hover:bg-white/90" : "bg-white/10 text-white/25")}>
            {processing ? <PiSpinnerGapBold className="animate-spin" /> : <PiExportDuotone />}
            Export
          </button>
        </div>
      </aside>
    </main>
  );
}

function Timeline({ duration, currentTime, markIn, markOut, segments, selectedSegmentId, onSeek, onSelect, onSetMarkIn, onSetMarkOut }: {
  duration: number;
  currentTime: number;
  markIn: number;
  markOut: number;
  segments: CutSegment[];
  selectedSegmentId: string;
  onSeek: (time: number) => void;
  onSelect: (segment: CutSegment) => void;
  onSetMarkIn: (time: number) => void;
  onSetMarkOut: (time: number) => void;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragModeRef = useRef<"playhead" | "in" | "out" | null>(null);
  const safeDuration = Math.max(duration, MIN_SEGMENT);
  const ticks = Math.max(4, Math.min(16, Math.ceil(safeDuration / 10)));

  const timeFromClientX = (clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clamp(((clientX - rect.left) / rect.width) * safeDuration, 0, safeDuration);
  };

  const updateDrag = (clientX: number) => {
    const time = timeFromClientX(clientX);
    if (dragModeRef.current === "in") {
      onSetMarkIn(clamp(time, 0, markOut - MIN_SEGMENT));
      return;
    }
    if (dragModeRef.current === "out") {
      onSetMarkOut(clamp(time, markIn + MIN_SEGMENT, safeDuration));
      return;
    }
    onSeek(time);
  };

  const beginDrag = (event: React.PointerEvent<HTMLElement>, mode: "playhead" | "in" | "out") => {
    event.preventDefault();
    event.stopPropagation();
    dragModeRef.current = mode;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDrag(event.clientX);
  };

  const continueDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!dragModeRef.current) return;
    event.preventDefault();
    updateDrag(event.clientX);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragModeRef.current = null;
  };

  return (
    <div className="mx-3 mt-2 h-[46px] shrink-0 overflow-hidden rounded-xl border border-white/[0.075] bg-[#111216]">
      <div ref={timelineRef}
        className="relative h-full cursor-ew-resize touch-none select-none overflow-hidden bg-[#3b3938]"
        onPointerDown={(event) => beginDrag(event, "playhead")}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}>
        {Array.from({ length: ticks + 1 }).map((_, index) => (
          <div key={index} className="absolute top-0 h-full border-l border-white/[0.12]" style={{ left: `${(index / ticks) * 100}%` }}>
            <span className="sr-only">{fmt((safeDuration / ticks) * index, false)}</span>
          </div>
        ))}

        <div className="absolute inset-y-0 bg-white/[0.12] ring-1 ring-white/25"
          style={{ left: `${(markIn / safeDuration) * 100}%`, width: `${Math.max(0.25, ((markOut - markIn) / safeDuration) * 100)}%` }} />

        {segments.map(segment => (
          <button key={segment.id} type="button" onClick={(event) => { event.stopPropagation(); onSelect(segment); }}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn("absolute inset-y-0 border-x text-left", selectedSegmentId === segment.id ? "border-white bg-white/18" : "border-white/20 bg-black/5 hover:bg-white/10")}
            style={{ left: `${(segment.start / safeDuration) * 100}%`, width: `${Math.max(0.4, ((segment.end - segment.start) / safeDuration) * 100)}%` }}>
            <span className="sr-only">{segment.name}</span>
          </button>
        ))}

        <button type="button" title="Drag in marker"
          onPointerDown={(event) => beginDrag(event, "in")}
          onPointerMove={continueDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="absolute inset-y-0 w-2 -translate-x-1 border-x border-black/25 bg-white/75" style={{ left: `${(markIn / safeDuration) * 100}%` }} />
        <button type="button" title="Drag out marker"
          onPointerDown={(event) => beginDrag(event, "out")}
          onPointerMove={continueDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="absolute inset-y-0 w-2 -translate-x-1 border-x border-black/25 bg-white/75" style={{ left: `${(markOut / safeDuration) * 100}%` }} />

        <div className="absolute top-0 h-full w-px bg-white" style={{ left: `${(currentTime / safeDuration) * 100}%` }}>
          <button type="button" title="Drag playhead"
            onPointerDown={(event) => beginDrag(event, "playhead")}
            onPointerMove={continueDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute left-1/2 top-0 h-full w-5 -translate-x-1/2 cursor-ew-resize">
            <span className="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 border-x-[7px] border-t-[9px] border-x-transparent border-t-white" />
            <span className="absolute left-1/2 top-2 h-[calc(100%-0.5rem)] w-1 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
            <span className="sr-only">Drag playhead at {fmt(currentTime)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TimeField({ label, value, min = 0, max, onChange }: { label: string; value: number; min?: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-white/45">{label}</span>
      <input value={fmt(value)} onChange={event => onChange(clamp(parseTime(event.target.value), min, max))}
        className="h-8 w-full rounded-lg border border-white/[0.075] bg-black/20 px-2 font-mono text-[10px] text-white/80 outline-none" />
    </label>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.075] bg-white/[0.045] text-white/65 hover:bg-white/[0.08] hover:text-white">
      {children}
    </button>
  );
}

function TransportButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      className="grid h-7 min-w-7 place-items-center rounded-lg border border-white/[0.075] bg-white/[0.075] px-2 font-mono text-[12px] font-bold text-white hover:bg-white/[0.12] disabled:opacity-30">
      {children}
    </button>
  );
}
