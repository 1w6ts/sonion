use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::fs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const API_BASE: &str = "https://xype.gg"; // set your backend URL, e.g. "https://api.xype.gg"

fn ffmpeg_cmd(path: &PathBuf) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn hidden_cmd(path: &PathBuf) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[tauri::command]
fn read_smoothie_recipe(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("Recipe file not found".to_string());
    }
    if path.extension().and_then(|s| s.to_str()).map(|s| !s.eq_ignore_ascii_case("ini")).unwrap_or(true) {
        return Err("Only Smoothie .ini recipes are supported".to_string());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn merge_smoothie_recipe_ini(base: &mut Value, ini: &str) {
    let Some(data) = base.get_mut("data").and_then(|v| v.as_object_mut()) else {
        return;
    };

    let mut section = String::new();
    for raw_line in ini.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_lowercase();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let value = value.trim().trim_matches('"').to_string();
        if let Some(target) = data.get_mut(&section).and_then(|v| v.as_object_mut()) {
            target.insert(key, Value::String(value));
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessResult {
    pub success: bool,
    pub message: String,
    pub output_path: Option<String>,
}

fn normalize_compress_encoder(encoder: &str) -> (&'static str, &'static str) {
    match encoder {
        "libx265" => ("libx265", "-crf"),
        "h264_nvenc" => ("h264_nvenc", "-cq"),
        _ => ("libx264", "-crf"),
    }
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    pub ffmpeg_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthSession {
    pub token: String,
    pub user_id: String,
    pub email: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PublicAuthSession {
    pub user_id: String,
    pub email: String,
    pub expires_at: String,
}

impl From<&AuthSession> for PublicAuthSession {
    fn from(session: &AuthSession) -> Self {
        Self {
            user_id: session.user_id.clone(),
            email: session.email.clone(),
            expires_at: session.expires_at.clone(),
        }
    }
}

fn auth_session_path() -> Result<PathBuf, String> {
    let dir = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .map_err(|e| e.to_string())?;
    let path = PathBuf::from(dir).join("xype").join("auth.json");
    Ok(path)
}

fn store_auth_session(session: &AuthSession) -> Result<(), String> {
    let path = auth_session_path()?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::to_string(session).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_auth_session_inner() -> Result<Option<AuthSession>, String> {
    let path = auth_session_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map(Some).map_err(|e| e.to_string())
}

fn pending_auth_file() -> Result<PathBuf, String> {
    let dir = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .map_err(|e| e.to_string())?;
    Ok(PathBuf::from(dir).join("xype").join(".pending_auth"))
}

fn flush_pending_auth() -> Result<Option<AuthSession>, String> {
    let path = pending_auth_file()?;
    if !path.exists() {
        return Ok(None);
    }
    let url = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let trimmed = url.trim();
    if trimmed.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(None);
    }
    let session = parse_auth_callback(trimmed)?;
    store_auth_session(&session)?;
    let _ = fs::remove_file(&path);
    Ok(Some(session))
}

fn parse_auth_callback(url: &str) -> Result<AuthSession, String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    let path = parsed.path();
    if parsed.scheme() != "xype" || parsed.host_str() != Some("auth") || (path != "/callback" && path != "/callback/") {
        return Err(format!("Ignored non-auth deep link: path={}", path));
    }

    let mut token = None;
    let mut user_id = None;
    let mut email = None;
    let mut expires_at = None;

    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "token" => token = Some(value.into_owned()),
            "user_id" => user_id = Some(value.into_owned()),
            "email" => email = Some(value.into_owned()),
            "expires_at" => expires_at = Some(value.into_owned()),
            _ => {}
        }
    }

    Ok(AuthSession {
        token: token.filter(|v| !v.is_empty()).ok_or_else(|| "Auth callback missing token".to_string())?,
        user_id: user_id.filter(|v| !v.is_empty()).ok_or_else(|| "Auth callback missing user_id".to_string())?,
        email: email.filter(|v| !v.is_empty()).ok_or_else(|| "Auth callback missing email".to_string())?,
        expires_at: expires_at.filter(|v| !v.is_empty()).ok_or_else(|| "Auth callback missing expires_at".to_string())?,
    })
}

fn handle_auth_deep_link(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let session = parse_auth_callback(url)?;
    store_auth_session(&session)?;
    app.emit("auth-session-updated", PublicAuthSession::from(&session)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_auth_session() -> Result<Option<PublicAuthSession>, String> {
    load_auth_session_inner().map(|session| session.as_ref().map(PublicAuthSession::from))
}

#[tauri::command]
fn logout_auth_session() -> Result<(), String> {
    let path = auth_session_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementsResp {
    user_id: String,
    email: String,
    is_paid: bool,
    subscription: Option<serde_json::Value>,
    expires_at: Option<String>,
}

async fn fetch_subscription_status(token: &str) -> Result<bool, String> {
    if API_BASE.is_empty() {
        return Ok(true);
    }
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}/api/me/entitlements", API_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Subscription check failed: HTTP {}", res.status()));
    }
    let body: EntitlementsResp = res.json().await.map_err(|e| e.to_string())?;
    Ok(body.is_paid)
}

#[derive(Debug, Serialize)]
struct AccessCheck {
    access: bool,
    auth: bool,
    subscription: bool,
    error: Option<String>,
}

#[tauri::command]
async fn check_app_access_detailed() -> Result<AccessCheck, String> {
    let _ = flush_pending_auth();
    let session = match load_auth_session_inner() {
        Ok(Some(s)) => s,
        Ok(None) => {
            return Ok(AccessCheck {
                access: false,
                auth: false,
                subscription: false,
                error: Some("No saved session — log in via browser".to_string()),
            });
        }
        Err(e) => {
            return Ok(AccessCheck {
                access: false,
                auth: false,
                subscription: false,
                error: Some(format!("Keyring error: {}", e)),
            });
        }
    };

    match fetch_subscription_status(&session.token).await {
        Ok(true) => Ok(AccessCheck {
            access: true,
            auth: true,
            subscription: true,
            error: None,
        }),
        Ok(false) => Ok(AccessCheck {
            access: false,
            auth: true,
            subscription: false,
            error: Some("Subscription inactive / not paid".to_string()),
        }),
        Err(e) => Ok(AccessCheck {
            access: false,
            auth: true,
            subscription: false,
            error: Some(format!("Subscription check failed: {}", e)),
        }),
    }
}

#[tauri::command]
async fn check_app_access() -> Result<bool, String> {
    let detail = check_app_access_detailed().await?;
    Ok(detail.access)
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
    let video = PathBuf::from(video_path);

    if !ffmpeg.exists() {
        return Err("FFmpeg path does not exist".to_string());
    }
    if !video.exists() {
        return Err("Video file does not exist".to_string());
    }

    fn parse_fps_value(s: &str) -> Option<f64> {
        let s = s.trim();
        if s.is_empty() || s == "0/0" || s == "N/A" {
            return None;
        }
        if let Some((num, den)) = s.split_once('/') {
            if let (Ok(n), Ok(d)) = (num.trim().parse::<f64>(), den.trim().parse::<f64>()) {
                if d > 0.0 {
                    let fps = n / d;
                    if fps.is_finite() && fps > 0.0 {
                        return Some(fps);
                    }
                }
            }
        }
        if let Ok(fps) = s.parse::<f64>() {
            if fps.is_finite() && fps > 0.0 {
                return Some(fps);
            }
        }
        None
    }

    if let Some(parent) = ffmpeg.parent() {
        let ffprobe = parent.join("ffprobe.exe");
        if ffprobe.exists() {
            if let Ok(output) = ffmpeg_cmd(&ffprobe)
                .args([
                    "-v", "0",
                    "-select_streams", "v:0",
                    "-show_entries", "stream=avg_frame_rate,r_frame_rate",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    video_path,
                ])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if let Some(fps) = parse_fps_value(line) {
                        return Ok(fps);
                    }
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
            if let Some(fps) = parse_fps_value(tokens[i - 1]) {
                return Ok(fps);
            }
        }
    }

    Err("Could not detect FPS".to_string())
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

fn motion_runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("motion-runtime"))
}

#[tauri::command]
fn check_motion_runtime(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = motion_runtime_dir(&app)?;
    let vspipe = dir.join("vspipe.exe");
    let script = dir.join("xype_motion.vpy");
    let scripts_dir = dir.join("scripts");
    let havsfunc = scripts_dir.join("havsfunc.py");
    let blending = scripts_dir.join("blending.py");
    Ok(vspipe.exists() && script.exists() && havsfunc.exists() && blending.exists())
}

#[tauri::command]
async fn install_motion_runtime(app: tauri::AppHandle) -> Result<ProcessResult, String> {
    let runtime_dir = motion_runtime_dir(&app)?;
    let scripts_dir = runtime_dir.join("scripts");

    let _ = fs::create_dir_all(&runtime_dir);
    let _ = fs::create_dir_all(&scripts_dir);
    // Create __init__.py so 'scripts' is a proper Python package for internal imports
    let _ = fs::write(scripts_dir.join("__init__.py"), b"");

    // Always copy latest bundled script into app data (overwrite old)
    let bundled_script = app.path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("motion-runtime")
        .join("xype_motion.vpy");
    if bundled_script.exists() {
        let _ = fs::copy(&bundled_script, runtime_dir.join("xype_motion.vpy"));
    }

    let _ = app.emit("motion-runtime-progress", 5);

    // Download VapourSynth bundle
    let zip_path = std::env::temp_dir().join("VapourSynth-xype.7z");
    let vs_url = "https://github.com/couleurm/VSBundler/releases/latest/download/VapourSynth.7z";

    let client = reqwest::Client::new();
    let response = client.get(vs_url).send().await.map_err(|e| e.to_string())?;
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    fs::write(&zip_path, &bytes).map_err(|e| e.to_string())?;

    let _ = app.emit("motion-runtime-progress", 50);

    // Extract with pure-Rust 7z (no external 7-Zip needed)
    sevenz_rust2::decompress_file(&zip_path, &runtime_dir)
        .map_err(|e| format!("Failed to extract 7z archive: {}", e))?;

    let _ = fs::remove_file(&zip_path);
    let _ = app.emit("motion-runtime-progress", 70);

    // Flatten nested VapourSynth folder if present
    let nested = runtime_dir.join("VapourSynth");
    if nested.exists() {
        for entry in fs::read_dir(&nested).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let dest = runtime_dir.join(entry.file_name());
            let _ = fs::rename(entry.path(), dest);
        }
        let _ = fs::remove_dir_all(&nested);
    }

    // Download Smoothie scripts (havsfunc, blending, etc.)
    let script_urls = [
        ("https://raw.githubusercontent.com/couleur-tweak-tips/smoothie-rs/main/target/scripts/havsfunc.py", "havsfunc.py"),
        ("https://raw.githubusercontent.com/couleur-tweak-tips/smoothie-rs/main/target/scripts/blending.py", "blending.py"),
        ("https://raw.githubusercontent.com/couleur-tweak-tips/smoothie-rs/main/target/scripts/consts.py", "consts.py"),
        ("https://raw.githubusercontent.com/couleur-tweak-tips/smoothie-rs/main/target/scripts/weighting.py", "weighting.py"),
    ];

    for (i, (url, name)) in script_urls.iter().enumerate() {
        let response = client.get(*url).send().await.map_err(|e| e.to_string())?;
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        fs::write(scripts_dir.join(name), &bytes).map_err(|e| e.to_string())?;
        let _ = app.emit("motion-runtime-progress", 75 + ((i + 1) * 25 / script_urls.len()));
    }

    let _ = app.emit("motion-runtime-progress", 100);

    Ok(ProcessResult {
        success: true,
        message: "Motion runtime installed".to_string(),
        output_path: Some(runtime_dir.to_string_lossy().to_string()),
    })
}

#[tauri::command]
async fn render_video_motion_runtime(
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
    smoothie_recipe: Option<String>,
) -> Result<ProcessResult, String> {
    let input = PathBuf::from(&input_path);
    let ffmpeg = PathBuf::from(&ffmpeg_path);

    if !input.exists() {
        return Ok(ProcessResult { success: false, message: "Input file not found".to_string(), output_path: None });
    }

    let runtime = app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("motion-runtime");
    let vspipe = runtime.join("vspipe.exe");
    let script = runtime.join("xype_motion.vpy");

    // Always refresh script from bundled resources
    let bundled_script = app.path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("motion-runtime")
        .join("xype_motion.vpy");
    if bundled_script.exists() {
        let _ = fs::copy(&bundled_script, &script);
    }

    if !vspipe.exists() || !script.exists() {
        return Ok(ProcessResult {
            success: false,
            message: "Motion engine is not installed. Click 'Install motion engine' in the Motion Blur module.".to_string(),
            output_path: None,
        });
    }

    let duration = probe_duration(&ffmpeg, &input);
    let effective_timescale = if timescale > 0.0 { timescale } else { 1.0 };
    let output_duration = if effective_timescale != 1.0 { duration / effective_timescale } else { duration };

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let output_path = input_dir.join(format!("{}_motion.mp4", input_name));
    if output_path.exists() { let _ = fs::remove_file(&output_path); }

    let interpolation_enabled = interpolate_fps > 0;
    let working_fps = interpolate_fps.max(output_fps).max(1);
    let blur_intensity = ((frames_to_blend as f64 * output_fps as f64) / working_fps as f64).clamp(0.1, 4.0);
    let mut recipe_value = serde_json::json!({
        "data": {
            "interpolation": {
                "enabled": if interpolation_enabled { "yes" } else { "no" },
                "fps": working_fps.to_string(),
                "speed": "medium",
                "tuning": "smooth",
                "algorithm": "23",
                "block size": "auto",
                "use gpu": "yes"
            },
            "frame blending": {
                "enabled": if frames_to_blend > 1 { "yes" } else { "no" },
                "fps": output_fps.to_string(),
                "intensity": blur_intensity.to_string(),
                "weighting": blend_weighting
            },
            "flowblur": {
                "enabled": "no",
                "amount": "0",
                "do blending": "after"
            },
            "miscellaneous": {
                "source plugin": "bestsource",
                "always verbose": "no"
            },
            "timescale": {
                "in": "1.0",
                "out": effective_timescale.to_string()
            }
        }
    });
    if let Some(recipe_text) = smoothie_recipe.as_deref().filter(|s| !s.trim().is_empty()) {
        merge_smoothie_recipe_ini(&mut recipe_value, recipe_text);
    }
    let recipe = recipe_value.to_string();

    let mut path_env = runtime.to_string_lossy().to_string();
    if let Ok(existing) = std::env::var("PATH") {
        path_env.push(';');
        path_env.push_str(&existing);
    }

    let mut vs_cmd = hidden_cmd(&vspipe);
    vs_cmd.current_dir(&runtime)
        .env("PATH", path_env)
        .arg("--container")
        .arg("y4m")
        .arg("-")
        .arg(&script)
        .arg("--arg")
        .arg(format!("recipe={recipe}"))
        .arg("--arg")
        .arg(format!("input_video={}", input.to_string_lossy()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut vs_child = vs_cmd.spawn().map_err(|e| e.to_string())?;
    let vs_stdout = vs_child.stdout.take().ok_or_else(|| "Failed to capture VSPipe output".to_string())?;
    let vs_stderr = vs_child.stderr.take().ok_or_else(|| "Failed to capture VSPipe errors".to_string())?;

    let is_nvenc = encoder == "h264_nvenc";
    let codec = if is_nvenc { "h264_nvenc" } else { "libx264" };
    let quality_flag = if is_nvenc { "-cq" } else { "-crf" };
    let preset = if is_nvenc { "p5" } else { "slow" };

    let audio_filter = if (effective_timescale - 1.0).abs() > 0.001 {
        Some(audio_tempo_filter(effective_timescale))
    } else {
        None
    };

    let mut ff_cmd = ffmpeg_cmd(&ffmpeg);
    ff_cmd.stdin(Stdio::from(vs_stdout))
        .arg("-y")
        .arg("-f").arg("yuv4mpegpipe")
        .arg("-i").arg("-")
        .arg("-i").arg(&input)
        .arg("-map").arg("0:v:0")
        .arg("-map").arg("1:a?")
        .arg("-shortest")
        .arg("-c:v").arg(codec)
        .arg(quality_flag).arg(crf.to_string());

    if is_nvenc {
        ff_cmd.arg("-pix_fmt").arg("yuv420p").arg("-preset").arg(preset);
    } else {
        ff_cmd.arg("-preset").arg(preset).arg("-pix_fmt").arg("yuv420p");
    }

    if let Some(ref af) = audio_filter {
        ff_cmd.arg("-af").arg(af).arg("-c:a").arg("aac");
    } else {
        ff_cmd.arg("-c:a").arg("copy");
    }

    ff_cmd.arg("-progress").arg("pipe:1")
        .arg("-nostats")
        .arg(&output_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut ff_child = ff_cmd.spawn().map_err(|e| e.to_string())?;
    let ff_stdout = ff_child.stdout.take().ok_or_else(|| "Failed to capture FFmpeg progress".to_string())?;
    let ff_stderr = ff_child.stderr.take().ok_or_else(|| "Failed to capture FFmpeg errors".to_string())?;

    let app_clone = app.clone();
    let progress_handle = std::thread::spawn(move || {
        let reader = BufReader::new(ff_stdout);
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

    let vs_stderr_handle = std::thread::spawn(move || {
        BufReader::new(vs_stderr).lines().flatten().collect::<Vec<_>>().join("\n")
    });
    let ff_stderr_handle = std::thread::spawn(move || {
        BufReader::new(ff_stderr).lines().flatten().collect::<Vec<_>>().join("\n")
    });

    let ff_status = ff_child.wait().map_err(|e| e.to_string())?;
    let vs_status = vs_child.wait().map_err(|e| e.to_string())?;
    let _ = progress_handle.join();
    let vs_stderr_output = vs_stderr_handle.join().unwrap_or_default();
    let ff_stderr_output = ff_stderr_handle.join().unwrap_or_default();
    let _ = app.emit("render-progress", 1.0_f64);

    Ok(if ff_status.success() && vs_status.success() && output_path.exists() {
        ProcessResult {
            success: true,
            message: format!("xype motion runtime → {}fps", output_fps),
            output_path: output_path.to_str().map(|s| s.to_string()),
        }
    } else {
        ProcessResult {
            success: false,
            message: format!("Motion runtime error:\n{}\n{}", vs_stderr_output, ff_stderr_output),
            output_path: None,
        }
    })
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
        // FFmpeg minterpolate is too slow for real-time use; duplicate frames to target fps
        // True motion interpolation (like smoothie's SVPFlow) requires VapourSynth
        filters.push(format!("fps={}", interpolate_fps));
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
    cmd.stdin(Stdio::null())
        .arg("-y")
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
fn patch_tiktok_optimizer(input_path: String) -> Result<ProcessResult, String> {
    const TIKTOK_OPTIMIZER_MAX_BYTES: u64 = 90 * 1024 * 1024;

    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Ok(ProcessResult { success: false, message: "File not found".to_string(), output_path: None });
    }

    let input_size = fs::metadata(&input).map_err(|e| e.to_string())?.len();
    if input_size > TIKTOK_OPTIMIZER_MAX_BYTES {
        return Ok(ProcessResult {
            success: false,
            message: "TikTok Optimizer is capped at 90 MB to prevent device lag. Compress or trim the video first.".to_string(),
            output_path: None,
        });
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
async fn compress_video(
    app: tauri::AppHandle,
    ffmpeg_path: String,
    input_path: String,
    encoder: String,
    quality: u32,
    preset: String,
    resolution: String,
    fps: u32,
    audio_kbps: u32,
) -> Result<ProcessResult, String> {
    let input = PathBuf::from(&input_path);
    let ffmpeg = PathBuf::from(&ffmpeg_path);

    if !input.exists() {
        return Ok(ProcessResult { success: false, message: "Input file not found".to_string(), output_path: None });
    }
    if !ffmpeg.exists() {
        return Ok(ProcessResult { success: false, message: "FFmpeg not found".to_string(), output_path: None });
    }

    let duration = probe_duration(&ffmpeg, &input);
    if duration <= 0.0 {
        return Ok(ProcessResult { success: false, message: "Could not detect video duration".to_string(), output_path: None });
    }

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let output_path = input_dir.join(format!("{}_compressed.mp4", input_name));
    if output_path.exists() {
        let _ = fs::remove_file(&output_path);
    }

    let (codec, quality_flag) = normalize_compress_encoder(&encoder);
    let q = quality.clamp(10, 32);
    let preset = if preset == "medium" || preset == "slow" || preset == "slower" {
        preset
    } else {
        "slow".to_string()
    };
    let audio = audio_kbps.clamp(64, 320);

    let mut filters: Vec<String> = Vec::new();
    match resolution.as_str() {
        "1080" => filters.push("scale=-2:'min(ih,1080)'".to_string()),
        "720" => filters.push("scale=-2:'min(ih,720)'".to_string()),
        "480" => filters.push("scale=-2:'min(ih,480)'".to_string()),
        _ => {}
    }
    if fps > 0 {
        filters.push(format!("fps={}", fps.min(240)));
    }
    filters.push("format=yuv420p".to_string());
    let filter_str = filters.join(",");

    let mut cmd = ffmpeg_cmd(&ffmpeg);
    cmd.stdin(Stdio::null())
        .arg("-y")
        .arg("-i").arg(&input)
        .arg("-vf").arg(&filter_str)
        .arg("-c:v").arg(codec)
        .arg(quality_flag).arg(q.to_string());

    if codec == "h264_nvenc" {
        let nvenc_preset = match preset.as_str() {
            "medium" => "p4",
            "slower" => "p7",
            _ => "p6",
        };
        cmd.arg("-preset").arg(nvenc_preset);
    } else {
        cmd.arg("-preset").arg(&preset);
    }

    if codec == "libx265" {
        cmd.arg("-tag:v").arg("hvc1");
    }

    cmd.arg("-c:a").arg("aac")
        .arg("-b:a").arg(format!("{}k", audio))
        .arg("-movflags").arg("+faststart")
        .arg("-progress").arg("pipe:1")
        .arg("-nostats")
        .arg(&output_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Failed to capture FFmpeg progress".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Failed to capture FFmpeg errors".to_string())?;

    let app_clone = app.clone();
    let progress_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let parsed = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
                .and_then(|value| value.parse::<f64>().ok());
            if let Some(us) = parsed {
                if duration > 0.0 {
                    let pct = (us / 1_000_000.0 / duration).min(1.0);
                    let _ = app_clone.emit("compress-progress", pct);
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
    let _ = app.emit("compress-progress", 1.0_f64);

    if status.success() && output_path.exists() {
        let in_size = fs::metadata(&input).map(|m| m.len()).unwrap_or(0);
        let out_size = fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
        let out_mb = out_size as f64 / (1024.0 * 1024.0);
        let saved = if in_size > 0 && out_size <= in_size {
            let pct = 100.0 - (out_size as f64 / in_size as f64 * 100.0);
            format!(" - saved {:.0}%", pct.max(0.0))
        } else {
            "".to_string()
        };
        Ok(ProcessResult {
            success: true,
            message: format!("Compressed to {:.2} MB{}", out_mb, saved),
            output_path: output_path.to_str().map(|s| s.to_string()),
        })
    } else {
        Ok(ProcessResult {
            success: false,
            message: format!("FFmpeg error: {}", stderr_output),
            output_path: None,
        })
    }
}

#[tauri::command]
async fn compress_for_discord(
    app: tauri::AppHandle,
    ffmpeg_path: String,
    input_path: String,
) -> Result<ProcessResult, String> {
    let input = PathBuf::from(&input_path);
    let ffmpeg = PathBuf::from(&ffmpeg_path);

    if !input.exists() {
        return Ok(ProcessResult {
            success: false,
            message: "Input file not found".to_string(),
            output_path: None,
        });
    }
    if !ffmpeg.exists() {
        return Ok(ProcessResult {
            success: false,
            message: "FFmpeg not found".to_string(),
            output_path: None,
        });
    }

    let duration = probe_duration(&ffmpeg, &input);
    if duration <= 0.0 {
        return Ok(ProcessResult {
            success: false,
            message: "Could not detect video duration".to_string(),
            output_path: None,
        });
    }

    let default_dir = PathBuf::from(".");
    let input_dir = input.parent().unwrap_or(&default_dir);
    let input_name = input.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let output_path = input_dir.join(format!("{}_discord.mp4", input_name));
    if output_path.exists() {
        let _ = fs::remove_file(&output_path);
    }

    // Target 7.5 MB (headroom under 8 MB)
    let target_mb = 7.5_f64;
    let target_bits = target_mb * 1024.0 * 1024.0 * 8.0;
    let audio_kbps: f64 = 96.0;
    let mut video_kbps = (target_bits / duration) / 1000.0 - audio_kbps;
    video_kbps = video_kbps.max(100.0);

    let scale_filter = if video_kbps >= 3500.0 {
        "scale=-2:1080"
    } else if video_kbps >= 1500.0 {
        "scale=-2:720"
    } else if video_kbps >= 700.0 {
        "scale=-2:480"
    } else {
        "scale=-2:360"
    };

    let vf = format!("{},fps=30,format=yuv420p", scale_filter);
    let vb = video_kbps.round() as u32;
    let maxrate = (video_kbps * 1.2).round() as u32;
    let bufsize = (video_kbps * 2.0).round() as u32;

    let mut cmd = ffmpeg_cmd(&ffmpeg);
    cmd.stdin(Stdio::null())
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-vf")
        .arg(&vf)
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("veryfast")
        .arg("-b:v")
        .arg(format!("{}k", vb))
        .arg("-maxrate")
        .arg(format!("{}k", maxrate))
        .arg("-bufsize")
        .arg(format!("{}k", bufsize))
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("96k")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-progress")
        .arg("pipe:1")
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
            if let Some(us_str) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us_str.parse::<f64>() {
                    if duration > 0.0 {
                        let pct = (us / 1_000_000.0 / duration).min(1.0);
                        let _ = app_clone.emit("discord-progress", pct);
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
    let _ = app.emit("discord-progress", 1.0_f64);

    if status.success() && output_path.exists() {
        let size = fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
        let size_mb = size as f64 / (1024.0 * 1024.0);
        let msg = if size_mb > 8.0 {
            format!(
                "Output is {:.2} MB (slightly over 8 MB). Try trimming or lowering resolution manually.",
                size_mb
            )
        } else {
            format!("Compressed to {:.2} MB · {} kbps", size_mb, vb)
        };
        Ok(ProcessResult {
            success: size_mb <= 8.0,
            message: msg,
            output_path: output_path.to_str().map(|s| s.to_string()),
        })
    } else {
        Ok(ProcessResult {
            success: false,
            message: format!("FFmpeg error: {}", stderr_output),
            output_path: None,
        })
    }
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
    // Windows deep-link second-instance shortcut: search ALL args for a xype:// URL,
    // write it to a pending-auth file, then exit. The running instance polls the file.
    let args: Vec<String> = std::env::args().collect();
    if let Some(url) = args.iter().map(|a| a.trim_matches('"').trim()).find(|a| a.starts_with("xype://")) {
        if !url.is_empty() {
            if let Ok(path) = pending_auth_file() {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(&path, url);
            }
        }
        std::process::exit(0);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            let handle = app.handle().clone();
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    if let Err(err) = handle_auth_deep_link(&handle, url.as_str()) {
                        eprintln!("deep link auth failed: {}", err);
                    }
                }
            }

            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Err(err) = handle_auth_deep_link(&handle, url.as_str()) {
                        eprintln!("deep link auth failed: {}", err);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            validate_ffmpeg,
            get_video_fps,
            export_segments,
            render_video,
            read_smoothie_recipe,
            render_video_motion_runtime,
            check_motion_runtime,
            install_motion_runtime,
            patch_tiktok_optimizer,
            compress_video,
            compress_for_discord,
            reveal_in_explorer,
            get_auth_session,
            logout_auth_session,
            check_app_access,
            check_app_access_detailed,
            load_config,
            save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
