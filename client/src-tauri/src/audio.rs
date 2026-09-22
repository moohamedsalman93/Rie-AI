use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use std::io::{BufRead, BufReader, Cursor};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

struct SampleBuffer {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

pub struct NativeAudioRecorder {
    inner: Mutex<RecorderControl>,
}

struct RecorderControl {
    buffer: Arc<Mutex<SampleBuffer>>,
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Default for NativeAudioRecorder {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RecorderControl {
                buffer: Arc::new(Mutex::new(SampleBuffer {
                    samples: Vec::new(),
                    sample_rate: 16_000,
                    channels: 1,
                })),
                stop_flag: Arc::new(AtomicBool::new(false)),
                thread: None,
            }),
        }
    }
}

fn encode_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: WavSampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
    for &sample in samples {
        let scaled = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(scaled).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

fn run_capture_thread(buffer: Arc<Mutex<SampleBuffer>>, stop_flag: Arc<AtomicBool>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No microphone device found".to_string())?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("Microphone config error: {e}"))?;

    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    {
        let mut guard = buffer.lock().map_err(|e| e.to_string())?;
        guard.samples.clear();
        guard.sample_rate = sample_rate;
        guard.channels = channels;
    }

    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let buffer_cb = buffer.clone();

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                if let Ok(mut guard) = buffer_cb.lock() {
                    guard.samples.extend_from_slice(data);
                }
            },
            |err| eprintln!("Microphone stream error: {err}"),
            None,
        ),
        SampleFormat::I16 => {
            let buffer_cb = buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    if let Ok(mut guard) = buffer_cb.lock() {
                        guard
                            .samples
                            .extend(data.iter().map(|&s| s as f32 / i16::MAX as f32));
                    }
                },
                |err| eprintln!("Microphone stream error: {err}"),
                None,
            )
        }
        SampleFormat::U16 => {
            let buffer_cb = buffer.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    if let Ok(mut guard) = buffer_cb.lock() {
                        guard.samples.extend(
                            data.iter()
                                .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0),
                        );
                    }
                },
                |err| eprintln!("Microphone stream error: {err}"),
                None,
            )
        }
        other => {
            return Err(format!("Unsupported microphone sample format: {other:?}"));
        }
    }
    .map_err(|e| format!("Failed to open microphone: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start microphone: {e}"))?;

    while !stop_flag.load(Ordering::Relaxed) {
        thread::sleep(std::time::Duration::from_millis(20));
    }

    drop(stream);
    Ok(())
}

#[tauri::command]
pub fn start_native_recording(state: tauri::State<'_, NativeAudioRecorder>) -> Result<(), String> {
    let mut control = state.inner.lock().map_err(|e| e.to_string())?;
    if control.thread.is_some() {
        return Ok(());
    }

    control.stop_flag.store(false, Ordering::Relaxed);
    {
        let mut guard = control.buffer.lock().map_err(|e| e.to_string())?;
        guard.samples.clear();
    }

    let buffer = control.buffer.clone();
    let stop_flag = control.stop_flag.clone();
    let thread = thread::Builder::new()
        .name("rie-mic-capture".into())
        .spawn(move || {
            if let Err(err) = run_capture_thread(buffer, stop_flag) {
                eprintln!("Native microphone capture failed: {err}");
            }
        })
        .map_err(|e| format!("Failed to start microphone thread: {e}"))?;

    control.thread = Some(thread);
    Ok(())
}

#[tauri::command]
pub fn stop_native_recording(state: tauri::State<'_, NativeAudioRecorder>) -> Result<Vec<u8>, String> {
    let mut control = state.inner.lock().map_err(|e| e.to_string())?;
    control.stop_flag.store(true, Ordering::Relaxed);

    if let Some(thread) = control.thread.take() {
        thread
            .join()
            .map_err(|_| "Microphone thread panicked".to_string())?;
    }

    let guard = control.buffer.lock().map_err(|e| e.to_string())?;
    if guard.samples.is_empty() {
        return Err("No audio captured".to_string());
    }

    encode_wav(&guard.samples, guard.sample_rate, guard.channels)
}

// ---------------------------------------------------------------------------
// Direct Windows WASAPI Live Voice Audio Streamer for Gemini Live
// ---------------------------------------------------------------------------

const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        result.push(B64_CHARS[(b0 >> 2) as usize] as char);
        result.push(B64_CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(B64_CHARS[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(B64_CHARS[(b2 & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

fn resample_to_16k(input: &[f32], in_rate: u32) -> Vec<f32> {
    if in_rate == 16_000 {
        return input.to_vec();
    }
    let ratio = in_rate as f64 / 16_000.0;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        if idx + 1 < input.len() {
            let sample = input[idx] * (1.0 - frac) + input[idx + 1] * frac;
            out.push(sample);
        } else if idx < input.len() {
            out.push(input[idx]);
        }
    }
    out
}

pub struct NativeLiveVoiceRecorder {
    inner: Mutex<LiveVoiceControl>,
}

struct LiveVoiceControl {
    stop_flag: Arc<AtomicBool>,
    is_muted: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Default for NativeLiveVoiceRecorder {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LiveVoiceControl {
                stop_flag: Arc::new(AtomicBool::new(false)),
                is_muted: Arc::new(AtomicBool::new(false)),
                thread: None,
            }),
        }
    }
}

impl NativeLiveVoiceRecorder {
    pub fn start(&self, app: tauri::AppHandle) -> Result<(), String> {
        let mut control = self.inner.lock().map_err(|e| e.to_string())?;
        if control.thread.is_some() {
            return Ok(());
        }

        control.stop_flag.store(false, Ordering::Relaxed);
        let stop_flag = control.stop_flag.clone();
        let is_muted = control.is_muted.clone();

        let thread = thread::Builder::new()
            .name("rie-live-voice-wasapi".into())
            .spawn(move || {
                if let Err(err) = run_live_voice_thread(app, stop_flag, is_muted) {
                    eprintln!("[NativeLiveVoice] Capture failed: {err}");
                }
            })
            .map_err(|e| format!("Failed to start WASAPI capture thread: {e}"))?;

        control.thread = Some(thread);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut control = self.inner.lock().map_err(|e| e.to_string())?;
        control.stop_flag.store(true, Ordering::Relaxed);
        if let Some(thread) = control.thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }

    pub fn set_muted(&self, muted: bool) {
        if let Ok(control) = self.inner.lock() {
            control.is_muted.store(muted, Ordering::Relaxed);
        }
    }
}

fn run_live_voice_thread(
    app: tauri::AppHandle,
    stop_flag: Arc<AtomicBool>,
    is_muted: Arc<AtomicBool>,
) -> Result<(), String> {
    use tauri::Emitter;

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No microphone device found on Windows".to_string())?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("Microphone config error: {e}"))?;

    let in_sample_rate = supported.sample_rate().0;
    let in_channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let queue = Arc::new(Mutex::new(Vec::<f32>::new()));
    let queue_cb = queue.clone();

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                if let Ok(mut q) = queue_cb.lock() {
                    q.extend_from_slice(data);
                }
            },
            |err| eprintln!("[NativeLiveVoice] cpal error: {err}"),
            None,
        ),
        SampleFormat::I16 => {
            let queue_cb = queue.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    if let Ok(mut q) = queue_cb.lock() {
                        q.extend(data.iter().map(|&s| s as f32 / i16::MAX as f32));
                    }
                },
                |err| eprintln!("[NativeLiveVoice] cpal error: {err}"),
                None,
            )
        }
        SampleFormat::U16 => {
            let queue_cb = queue.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    if let Ok(mut q) = queue_cb.lock() {
                        q.extend(data.iter().map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0));
                    }
                },
                |err| eprintln!("[NativeLiveVoice] cpal error: {err}"),
                None,
            )
        }
        other => return Err(format!("Unsupported microphone sample format: {other:?}")),
    }
    .map_err(|e| format!("Failed to open WASAPI microphone: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start WASAPI stream: {e}"))?;

    let mut mono_buf = Vec::<f32>::new();

    while !stop_flag.load(Ordering::Relaxed) {
        // Sleep ~32ms to output ~512 samples per chunk at 16kHz
        thread::sleep(std::time::Duration::from_millis(32));

        let raw_samples: Vec<f32> = {
            if let Ok(mut q) = queue.lock() {
                q.drain(..).collect()
            } else {
                Vec::new()
            }
        };

        if raw_samples.is_empty() {
            continue;
        }

        // 1. Downmix to mono
        mono_buf.clear();
        if in_channels == 1 {
            mono_buf.extend_from_slice(&raw_samples);
        } else {
            let frames = raw_samples.len() / in_channels;
            mono_buf.reserve(frames);
            for i in 0..frames {
                let mut sum = 0.0f32;
                for ch in 0..in_channels {
                    sum += raw_samples[i * in_channels + ch];
                }
                mono_buf.push(sum / in_channels as f32);
            }
        }

        // 2. Resample to 16kHz
        let resampled_16k = resample_to_16k(&mono_buf, in_sample_rate);
        if resampled_16k.is_empty() {
            continue;
        }

        // 3. Compute volume
        let muted = is_muted.load(Ordering::Relaxed);
        let mut sum_sq = 0.0f32;
        for &s in &resampled_16k {
            sum_sq += s * s;
        }
        let rms = (sum_sq / resampled_16k.len() as f32).sqrt();
        let volume = if muted { 0.0f32 } else { (rms * 5.0).min(1.0) };

        let _ = app.emit("rie-live-mic-volume", volume);

        if muted {
            continue;
        }

        // 4. Convert to PCM16 little-endian (stream full dynamic range to Gemini Live VAD)
        let mut pcm16 = Vec::with_capacity(resampled_16k.len() * 2);
        for s in resampled_16k {
            let clamped = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            pcm16.extend_from_slice(&clamped.to_le_bytes());
        }

        // 5. Base64 encode and emit
        let b64 = base64_encode(&pcm16);
        let _ = app.emit("rie-live-audio-chunk", b64);
    }

    drop(stream);
    Ok(())
}

#[tauri::command]
pub fn start_native_live_voice(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeLiveVoiceRecorder>,
) -> Result<(), String> {
    state.start(app)
}

#[tauri::command]
pub fn stop_native_live_voice(
    state: tauri::State<'_, NativeLiveVoiceRecorder>,
) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
pub fn set_native_live_voice_muted(
    state: tauri::State<'_, NativeLiveVoiceRecorder>,
    muted: bool,
) -> Result<(), String> {
    state.set_muted(muted);
    Ok(())
}

// ---------------------------------------------------------------------------
// Native Windows Wake Word Engine ("Hey Rie", "Rie", "Hi Rie", "OK Rie")
// Uses Windows built-in System.Speech.Recognition desktop recognizer (100% offline)
// ---------------------------------------------------------------------------

pub struct NativeWakeWordManager {
    inner: Mutex<Option<Child>>,
}

impl Default for NativeWakeWordManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl NativeWakeWordManager {
    pub fn start(&self, app: tauri::AppHandle) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(());
            }
        }
        *guard = None;

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let script = r#"
Add-Type -AssemblyName System.Speech
try {
    $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    # Dictation is more tolerant than an exact Choices grammar. Windows often
    # transcribes "Hey Rie" as "Hey Ree", "Hey Ray", or adds nearby words.
    # We filter the recognized text below instead of silently rejecting it at
    # the grammar layer.
    $dictation = New-Object System.Speech.Recognition.DictationGrammar
    $rec.LoadGrammar($dictation)
    $rec.SetInputToDefaultAudioDevice()

    [Console]::Out.WriteLine("WAKE_READY")
    [Console]::Out.Flush()

    while ($true) {
        $result = $rec.Recognize()
        if ($result) {
            # Check alternatives even when Windows returned a top transcript.
            # Preserve standalone pronunciations and punctuation such as "Hey, Ray".
            foreach ($candidate in @($result) + @($result.Alternates)) {
                $matched = $candidate.Text
                if ($matched -and $matched -match '(?i)\b(?:rie|ree|re|ray|rye|ria|riya|reya|ree-ah|ree-ay|rai|read|reed)\b') {
                    [Console]::Out.WriteLine("WAKE:" + $matched)
                    [Console]::Out.Flush()
                    break
                }
            }
        }
    }
} catch {
    [Console]::Out.WriteLine("WAKE_ERROR:" + $_.Exception.Message)
    [Console]::Out.Flush()
}
"#;

            let mut child = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to spawn native wake word listener: {e}"))?;

            let stdout = child.stdout.take().ok_or("Failed to open child stdout")?;
            let app_handle = app.clone();

            thread::Builder::new()
                .name("rie-wake-word-reader".into())
                .spawn(move || {
                    use tauri::Emitter;
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        if let Ok(l) = line {
                            let trimmed = l.trim();
                            if trimmed.starts_with("WAKE:") {
                                let detected = trimmed.trim_start_matches("WAKE:").to_string();
                                println!("[NativeWakeWord] Detected wake word on Windows: {}", detected);
                                let _ = app_handle.emit("rie-native-wake-word", detected);
                            } else if trimmed.starts_with("HYPOTHESIS:") {
                                println!("[NativeWakeWord] Listening hypothesis: {}", trimmed.trim_start_matches("HYPOTHESIS:"));
                            } else if trimmed.starts_with("REJECTED:") {
                                println!("[NativeWakeWord] Low confidence rejected: {}", trimmed.trim_start_matches("REJECTED:"));
                            } else if trimmed.starts_with("WAKE_READY") {
                                println!("[NativeWakeWord] Windows Speech Recognition Engine is READY and listening.");
                            } else if trimmed.starts_with("WAKE_ERROR:") {
                                eprintln!("[NativeWakeWord] Engine error: {}", trimmed);
                            }
                        }
                    }
                })
                .map_err(|e| e.to_string())?;

            *guard = Some(child);
        }

        let _ = app;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

#[tauri::command]
pub fn start_native_wake_word(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeWakeWordManager>,
) -> Result<(), String> {
    state.start(app)
}

#[tauri::command]
pub fn stop_native_wake_word(
    state: tauri::State<'_, NativeWakeWordManager>,
) -> Result<(), String> {
    state.stop()
}
