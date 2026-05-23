use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::fs;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn ffmpeg_cmd(path: &PathBuf) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessResult {
    pub success: bool,
    pub message: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FpsConfig {
    pub fps: u32,
    pub scale: f64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    pub ffmpeg_path: String,
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("xype.json")
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> AppConfig {
    let path = config_path(&app);
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_fps_configs() -> Vec<FpsConfig> {
    vec![
        FpsConfig { fps: 60, scale: 2.0 },
        FpsConfig { fps: 120, scale: 6.0 },
        FpsConfig { fps: 240, scale: 12.0 },
    ]
}

#[tauri::command]
fn validate_ffmpeg(ffmpeg_path: &str) -> bool {
    let path = PathBuf::from(ffmpeg_path);
    if !path.exists() {
        return false;
    }
    match ffmpeg_cmd(&path).arg("-version").output() {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
fn get_video_fps(ffmpeg_path: &str, video_path: &str) -> Result<f64, String> {
    let ffmpeg = PathBuf::from(ffmpeg_path);

    if let Some(parent) = ffmpeg.parent() {
        let ffprobe = parent.join("ffprobe.exe");
        if ffprobe.exists() {
            if let Ok(output) = ffmpeg_cmd(&ffprobe)
                .args([
                    "-v", "0",
                    "-select_streams", "v:0",
                    "-show_entries", "stream=r_frame_rate",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    video_path,
                ])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let s = stdout.trim();
                if let Some((num, den)) = s.split_once('/') {
                    if let (Ok(n), Ok(d)) = (num.trim().parse::<f64>(), den.trim().parse::<f64>()) {
                        if d > 0.0 {
                            return Ok(n / d);
                        }
                    }
                }
                if let Ok(fps) = s.parse::<f64>() {
                    return Ok(fps);
                }
            }
        }
    }

    let output = ffmpeg_cmd(&ffmpeg)
        .arg("-i")
        .arg(video_path)
        .output()
        .map_err(|e| e.to_string())?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let tokens: Vec<&str> = stderr.split_whitespace().collect();
    for i in 1..tokens.len() {
        if tokens[i] == "fps" || tokens[i] == "tbr" {
            if let Ok(fps) = tokens[i - 1].parse::<f64>() {
                return Ok(fps);
            }
        }
    }

    Err("Could not detect FPS".to_string())
}

#[tauri::command]
async fn process_video(
    ffmpeg_path: &str,
    input_path: &str,
    _fps: u32,
    scale: f64,
) -> Result<ProcessResult, String> {
    let input = PathBuf::from(input_path);
    if !input.exists() {
        return Ok(ProcessResult {
            success: false,
            message: "Input file not found".to_string(),
            output_path: None,
        });
    }

    let ffmpeg = PathBuf::from(ffmpeg_path);
    if !ffmpeg.exists() {
        return Ok(ProcessResult {
            success: false,
            message: "FFmpeg executable not found".to_string(),
            output_path: None,
        });
    }

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let output_path = input_dir.join(format!("{}_output.mp4", input_name));

    if output_path.exists() {
        let _ = fs::remove_file(&output_path);
    }

    let scale_str = scale.to_string();

    let result = ffmpeg_cmd(&ffmpeg)
        .arg("-y")
        .arg("-itsscale").arg(&scale_str)
        .arg("-i").arg(&input)
        .arg("-c:v").arg("copy")
        .arg("-c:a").arg("copy")
        .arg(&output_path)
        .output();

    Ok(match result {
        Ok(output) => {
            if output.status.success() && output_path.exists() {
                ProcessResult {
                    success: true,
                    message: "Video processed successfully".to_string(),
                    output_path: output_path.to_str().map(|s| s.to_string()),
                }
            } else {
                let error_msg = String::from_utf8_lossy(&output.stderr);
                ProcessResult {
                    success: false,
                    message: format!("FFmpeg error: {}", error_msg),
                    output_path: None,
                }
            }
        }
        Err(e) => ProcessResult {
            success: false,
            message: format!("Failed to execute FFmpeg: {}", e),
            output_path: None,
        },
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
}

#[tauri::command]
async fn export_segments(
    ffmpeg_path: &str,
    input_path: &str,
    segments: Vec<Segment>,
) -> Result<ProcessResult, String> {
    if segments.is_empty() {
        return Ok(ProcessResult {
            success: false,
            message: "No segments to export".to_string(),
            output_path: None,
        });
    }

    let input = PathBuf::from(input_path);
    let ffmpeg = PathBuf::from(ffmpeg_path);

    if !input.exists() {
        return Ok(ProcessResult {
            success: false,
            message: "Input file not found".to_string(),
            output_path: None,
        });
    }

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");

    if segments.len() == 1 {
        let seg = &segments[0];
        let output_path = input_dir.join(format!("{}_trim.mp4", input_name));
        if output_path.exists() { let _ = fs::remove_file(&output_path); }
        let result = ffmpeg_cmd(&ffmpeg)
            .arg("-y")
            .arg("-ss").arg(seg.start.to_string())
            .arg("-to").arg(seg.end.to_string())
            .arg("-i").arg(&input)
            .arg("-c:v").arg("copy")
            .arg("-c:a").arg("copy")
            .arg("-avoid_negative_ts").arg("make_zero")
            .arg(&output_path)
            .output();
        return Ok(match result {
            Ok(out) if out.status.success() && output_path.exists() => ProcessResult {
                success: true,
                message: "Clip exported.".to_string(),
                output_path: output_path.to_str().map(|s| s.to_string()),
            },
            Ok(out) => ProcessResult {
                success: false,
                message: format!("FFmpeg error: {}", String::from_utf8_lossy(&out.stderr)),
                output_path: None,
            },
            Err(e) => ProcessResult { success: false, message: format!("Failed: {e}"), output_path: None },
        });
    }

    let temp_dir = std::env::temp_dir();
    let mut temp_files: Vec<PathBuf> = Vec::new();

    for (i, seg) in segments.iter().enumerate() {
        let temp_path = temp_dir.join(format!("xype_seg_{i}.mp4"));
        if temp_path.exists() { let _ = fs::remove_file(&temp_path); }
        let result = ffmpeg_cmd(&ffmpeg)
            .arg("-y")
            .arg("-ss").arg(seg.start.to_string())
            .arg("-to").arg(seg.end.to_string())
            .arg("-i").arg(&input)
            .arg("-c:v").arg("copy")
            .arg("-c:a").arg("copy")
            .arg("-avoid_negative_ts").arg("make_zero")
            .arg(&temp_path)
            .output();
        match result {
            Ok(out) if out.status.success() && temp_path.exists() => { temp_files.push(temp_path); }
            Ok(out) => {
                for f in &temp_files { let _ = fs::remove_file(f); }
                return Ok(ProcessResult {
                    success: false,
                    message: format!("Segment {} failed: {}", i + 1, String::from_utf8_lossy(&out.stderr)),
                    output_path: None,
                });
            }
            Err(e) => {
                for f in &temp_files { let _ = fs::remove_file(f); }
                return Ok(ProcessResult {
                    success: false,
                    message: format!("Segment {} failed: {e}", i + 1),
                    output_path: None,
                });
            }
        }
    }

    let list_path = temp_dir.join("xype_concat.txt");
    let list_content: String = temp_files.iter()
        .map(|p| format!("file '{}'\n", p.to_str().unwrap_or("").replace('\\', "/")))
        .collect();
    if let Err(e) = fs::write(&list_path, &list_content) {
        for f in &temp_files { let _ = fs::remove_file(f); }
        return Err(e.to_string());
    }

    let output_path = input_dir.join(format!("{}_export.mp4", input_name));
    if output_path.exists() { let _ = fs::remove_file(&output_path); }

    let result = ffmpeg_cmd(&ffmpeg)
        .arg("-y")
        .arg("-f").arg("concat")
        .arg("-safe").arg("0")
        .arg("-i").arg(&list_path)
        .arg("-c").arg("copy")
        .arg(&output_path)
        .output();

    for f in &temp_files { let _ = fs::remove_file(f); }
    let _ = fs::remove_file(&list_path);

    Ok(match result {
        Ok(out) if out.status.success() && output_path.exists() => ProcessResult {
            success: true,
            message: format!("{} segments merged.", segments.len()),
            output_path: output_path.to_str().map(|s| s.to_string()),
        },
        Ok(out) => ProcessResult {
            success: false,
            message: format!("Merge failed: {}", String::from_utf8_lossy(&out.stderr)),
            output_path: None,
        },
        Err(e) => ProcessResult { success: false, message: format!("Failed: {e}"), output_path: None },
    })
}

fn probe_duration(ffmpeg: &PathBuf, input: &PathBuf) -> f64 {
    if let Some(parent) = ffmpeg.parent() {
        let ffprobe = parent.join("ffprobe.exe");
        if ffprobe.exists() {
            if let Ok(out) = ffmpeg_cmd(&ffprobe)
                .args(["-v", "0", "-show_entries", "format=duration",
                       "-of", "default=noprint_wrappers=1:nokey=1",
                       input.to_str().unwrap_or("")])
                .output()
            {
                if let Ok(d) = String::from_utf8_lossy(&out.stdout).trim().parse::<f64>() {
                    return d;
                }
            }
        }
    }
    if let Ok(out) = ffmpeg_cmd(ffmpeg).arg("-i").arg(input).output() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        for line in stderr.lines() {
            if let Some(pos) = line.find("Duration: ") {
                let s = &line[pos + 10..];
                let parts: Vec<&str> = s.split(':').collect();
                if parts.len() >= 3 {
                    if let (Ok(h), Ok(m)) = (parts[0].trim().parse::<f64>(), parts[1].parse::<f64>()) {
                        if let Ok(sec) = parts[2].split(',').next().unwrap_or("").trim().parse::<f64>() {
                            return h * 3600.0 + m * 60.0 + sec;
                        }
                    }
                }
            }
        }
    }
    0.0
}

fn blend_weights(frames: u32, weighting: &str) -> String {
    let n = frames as usize;
    match weighting {
        "gaussian" => {
            let center = (n as f64 - 1.0) / 2.0;
            let sigma = (center / 2.0).max(0.5);
            let w: Vec<String> = (0..n).map(|i| {
                let x = (i as f64 - center) / sigma;
                format!("{:.3}", (-0.5 * x * x).exp())
            }).collect();
            w.join(" ")
        }
        "pyramid" => {
            let half = (n + 1) / 2;
            (0..n).map(|i| {
                let d = if i < half { i + 1 } else { n - i };
                d.to_string()
            }).collect::<Vec<_>>().join(" ")
        }
        // Ascending ladder — like Vegas Pro style, gives more weight to recent frames
        "vegas" => {
            (1..=n).map(|i| i.to_string()).collect::<Vec<_>>().join(" ")
        }
        "equal" => String::new(),
        // Custom: pass through if it's space-separated numbers, else fall back to equal
        custom => {
            if custom.split_whitespace().all(|s| s.parse::<f64>().is_ok()) && !custom.is_empty() {
                custom.to_string()
            } else {
                String::new()
            }
        }
    }
}

// Build an atempo chain that handles any timescale (atempo only accepts 0.5-2.0 per stage)
fn audio_tempo_filter(timescale: f64) -> String {
    let mut filters: Vec<String> = Vec::new();
    let mut remaining = timescale;

    if remaining > 1.0 {
        while remaining > 2.0 {
            filters.push("atempo=2.0".to_string());
            remaining /= 2.0;
        }
        filters.push(format!("atempo={:.6}", remaining));
    } else {
        while remaining < 0.5 {
            filters.push("atempo=0.5".to_string());
            remaining *= 2.0;
        }
        filters.push(format!("atempo={:.6}", remaining));
    }

    filters.join(",")
}

#[tauri::command]
async fn render_video(
    app: tauri::AppHandle,
    ffmpeg_path: String,
    input_path: String,
    interpolate_fps: u32,
    output_fps: u32,
    frames_to_blend: u32,
    blend_weighting: String,
    encoder: String,
    crf: u32,
    timescale: f64,
) -> Result<ProcessResult, String> {
    let input = PathBuf::from(&input_path);
    let ffmpeg = PathBuf::from(&ffmpeg_path);

    if !input.exists() {
        return Ok(ProcessResult { success: false, message: "Input file not found".to_string(), output_path: None });
    }

    let duration = probe_duration(&ffmpeg, &input);
    let effective_timescale = if timescale > 0.0 { timescale } else { 1.0 };
    // Progress tracks against output duration
    let output_duration = if effective_timescale != 1.0 { duration / effective_timescale } else { duration };

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let output_path = input_dir.join(format!("{}_smoothie.mp4", input_name));
    if output_path.exists() { let _ = fs::remove_file(&output_path); }

    let mut filters: Vec<String> = Vec::new();

    if interpolate_fps > 0 {
        filters.push(format!(
            "minterpolate=fps={}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
            interpolate_fps
        ));
    }
    if frames_to_blend > 1 {
        let weights = blend_weights(frames_to_blend, &blend_weighting);
        if weights.is_empty() {
            filters.push(format!("tmix=frames={}", frames_to_blend));
        } else {
            filters.push(format!("tmix=frames={}:weights='{}'", frames_to_blend, weights));
        }
    }
    if (effective_timescale - 1.0).abs() > 0.001 {
        filters.push(format!("setpts={:.6}*PTS", 1.0 / effective_timescale));
    }
    filters.push(format!("fps={}", output_fps));

    let filter_str = filters.join(",");

    let is_nvenc = encoder == "h264_nvenc";
    let codec = if is_nvenc { "h264_nvenc" } else { "libx264" };
    let quality_flag = if is_nvenc { "-cq" } else { "-crf" };
    let preset = if is_nvenc { "p4" } else { "fast" };

    let use_timescale = (effective_timescale - 1.0).abs() > 0.001;
    let audio_filter = if use_timescale { Some(audio_tempo_filter(effective_timescale)) } else { None };

    let mut cmd = ffmpeg_cmd(&ffmpeg);
    cmd.arg("-y")
        .arg("-i").arg(&input)
        .arg("-vf").arg(&filter_str)
        .arg("-c:v").arg(codec)
        .arg(quality_flag).arg(crf.to_string());

    if is_nvenc {
        cmd.arg("-pix_fmt").arg("yuv420p")
            .arg("-preset").arg(preset);
    } else {
        cmd.arg("-preset").arg(preset);
    }

    if let Some(ref af) = audio_filter {
        cmd.arg("-af").arg(af).arg("-c:a").arg("aac");
    } else {
        cmd.arg("-c:a").arg("copy");
    }

    cmd.arg("-progress").arg("pipe:1")
        .arg("-nostats")
        .arg(&output_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_clone = app.clone();
    let progress_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if let Some(us_str) = line.strip_prefix("out_time_ms=") {
                if let Ok(us) = us_str.parse::<f64>() {
                    if output_duration > 0.0 {
                        let pct = (us / 1_000_000.0 / output_duration).min(1.0);
                        let _ = app_clone.emit("render-progress", pct);
                    }
                }
            }
        }
    });

    let stderr_handle = std::thread::spawn(move || {
        BufReader::new(stderr).lines().flatten().collect::<Vec<_>>().join("\n")
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = progress_handle.join();
    let stderr_output = stderr_handle.join().unwrap_or_default();
    let _ = app.emit("render-progress", 1.0_f64);

    Ok(if status.success() && output_path.exists() {
        ProcessResult {
            success: true,
            message: format!("{} frames blended → {}fps", frames_to_blend, output_fps),
            output_path: output_path.to_str().map(|s| s.to_string()),
        }
    } else {
        ProcessResult {
            success: false,
            message: format!("FFmpeg error: {}", stderr_output),
            output_path: None,
        }
    })
}

struct Mp4Box {
    offset: usize,
    content_start: usize,
    end: usize,
}

fn find_mp4_box(data: &[u8], start: usize, search_end: usize, box_type: &[u8; 4]) -> Option<Mp4Box> {
    let mut pos = start;
    let limit = search_end.min(data.len());
    while pos + 8 <= limit {
        let size_u32 = u32::from_be_bytes([data[pos], data[pos+1], data[pos+2], data[pos+3]]) as usize;
        let (box_size, header_size) = if size_u32 == 1 {
            if pos + 16 > limit { break; }
            let hi = u32::from_be_bytes([data[pos+8],  data[pos+9],  data[pos+10], data[pos+11]]) as u64;
            let lo = u32::from_be_bytes([data[pos+12], data[pos+13], data[pos+14], data[pos+15]]) as u64;
            ((hi << 32 | lo) as usize, 16usize)
        } else if size_u32 == 0 {
            (limit - pos, 8usize)
        } else {
            (size_u32, 8usize)
        };
        if box_size < header_size || pos + box_size > limit { break; }
        if data[pos+4..pos+8] == *box_type {
            return Some(Mp4Box { offset: pos, content_start: pos + header_size, end: pos + box_size });
        }
        pos += box_size;
    }
    None
}

#[tauri::command]
fn patch_tiktok_clean(input_path: String) -> Result<ProcessResult, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Ok(ProcessResult { success: false, message: "File not found".to_string(), output_path: None });
    }

    let mut buf = fs::read(&input).map_err(|e| e.to_string())?;
    let len = buf.len();

    let moov = match find_mp4_box(&buf, 0, len, b"moov") {
        Some(b) => b,
        None => return Ok(ProcessResult { success: false, message: "\"moov\" box not found — is this a valid MP4?".to_string(), output_path: None }),
    };
    let mvhd = match find_mp4_box(&buf, moov.content_start, moov.end, b"mvhd") {
        Some(b) => b,
        None => return Ok(ProcessResult { success: false, message: "\"mvhd\" box not found inside \"moov\"".to_string(), output_path: None }),
    };

    let version = buf[mvhd.content_start];
    let matrix_offset = match version {
        0 => mvhd.offset + 44,
        1 => mvhd.offset + 56,
        v => return Ok(ProcessResult { success: false, message: format!("Unsupported mvhd version: {}", v), output_path: None }),
    };

    let b_offset = matrix_offset + 4;
    if b_offset + 4 > mvhd.end {
        return Ok(ProcessResult { success: false, message: "mvhd box too short to patch".to_string(), output_path: None });
    }

    buf[b_offset]     = 0;
    buf[b_offset + 1] = 0;
    buf[b_offset + 2] = 0;
    buf[b_offset + 3] = 1;

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let output_path = input_dir.join(format!("{}_clean.mp4", input_name));

    fs::write(&output_path, &buf).map_err(|e| e.to_string())?;

    Ok(ProcessResult {
        success: true,
        message: "Patched. Ready to upload.".to_string(),
        output_path: output_path.to_str().map(|s| s.to_string()),
    })
}

#[tauri::command]
async fn reveal_in_explorer(path: String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg bypasses Rust's quoting so Explorer receives: /select,"C:\path\to\file"
        let _ = Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_fps_configs,
            validate_ffmpeg,
            get_video_fps,
            process_video,
            export_segments,
            render_video,
            patch_tiktok_clean,
            reveal_in_explorer,
            load_config,
            save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
