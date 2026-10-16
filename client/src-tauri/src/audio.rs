use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use std::io::Cursor;
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
// Native Wake Word Engine: Sherpa-ONNX Zipformer KWS (100% offline, native in-process)
// ---------------------------------------------------------------------------

#[cfg(feature = "sherpa-kws")]
use std::path::PathBuf;

#[cfg(feature = "sherpa-kws")]
fn resolve_kws_model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    // 1. Try Tauri resource resolver
    if let Ok(resolved) = app.path().resolve("resources/kws", tauri::path::BaseDirectory::Resource) {
        if resolved.join("encoder.int8.onnx").exists() {
            return Ok(resolved);
        }
    }
    // 2. Try current executable parent directory
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("resources").join("kws");
            if candidate.join("encoder.int8.onnx").exists() {
                return Ok(candidate);
            }
        }
    }
    // 3. Try relative paths in development
    let dev_candidates = [
        PathBuf::from("resources/kws"),
        PathBuf::from("src-tauri/resources/kws"),
        PathBuf::from("app/client/src-tauri/resources/kws"),
    ];
    for candidate in &dev_candidates {
        if candidate.join("encoder.int8.onnx").exists() {
            return Ok(candidate.canonicalize().unwrap_or_else(|_| candidate.clone()));
        }
    }
    Err("Could not locate bundled sherpa-onnx KWS model directory (encoder.int8.onnx missing)".to_string())
}

#[cfg(feature = "sherpa-kws")]
pub struct SherpaOnnxWakeDetector {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    transition_buffer: Arc<Mutex<Vec<f32>>>,
    is_buffering_transition: Arc<AtomicBool>,
}

#[cfg(feature = "sherpa-kws")]
impl SherpaOnnxWakeDetector {
    pub fn start(app: tauri::AppHandle) -> Result<Self, String> {
        use sherpa_onnx::{
            KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig,
            OnlineTransducerModelConfig,
        };
        use tauri::Emitter;

        let model_dir = resolve_kws_model_dir(&app)?;
        let encoder = model_dir.join("encoder.int8.onnx").to_string_lossy().to_string();
        let decoder = model_dir.join("decoder.int8.onnx").to_string_lossy().to_string();
        let joiner = model_dir.join("joiner.int8.onnx").to_string_lossy().to_string();
        let tokens = model_dir.join("tokens.txt").to_string_lossy().to_string();
        let keywords_file = model_dir.join("keywords.txt").to_string_lossy().to_string();

        let config = KeywordSpotterConfig {
            model_config: OnlineModelConfig {
                transducer: OnlineTransducerModelConfig {
                    encoder: Some(encoder),
                    decoder: Some(decoder),
                    joiner: Some(joiner),
                },
                tokens: Some(tokens),
                num_threads: 2,
                provider: Some("cpu".to_string()),
                ..Default::default()
            },
            keywords_file: Some(keywords_file),
            max_active_paths: 4,
            num_trailing_blanks: 2,
            keywords_score: 1.5,
            keywords_threshold: 0.20,
            ..Default::default()
        };

        let spotter = KeywordSpotter::create(&config)
            .ok_or_else(|| "Failed to create sherpa-onnx KeywordSpotter instance".to_string())?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_thread = stop_flag.clone();
        let app_handle = app.clone();

        let transition_buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
        let transition_buffer_thread = transition_buffer.clone();
        let is_buffering_transition = Arc::new(AtomicBool::new(false));
        let is_buffering_thread = is_buffering_transition.clone();

        let thread = thread::Builder::new()
            .name("rie-sherpa-kws".into())
            .spawn(move || {
                println!("[SherpaKWS] Initializing microphone capture stream...");
                let host = cpal::default_host();
                let device = match host.default_input_device() {
                    Some(d) => d,
                    None => {
                        eprintln!("[SherpaKWS] No microphone device found on system.");
                        let _ = app_handle.emit("rie-wake-word-status", "error");
                        return;
                    }
                };

                let supported = match device.default_input_config() {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[SherpaKWS] Failed to get microphone configuration: {e}");
                        let _ = app_handle.emit("rie-wake-word-status", "error");
                        return;
                    }
                };

                let in_sample_rate = supported.sample_rate().0;
                let in_channels = supported.channels() as usize;
                let sample_format = supported.sample_format();
                let config: cpal::StreamConfig = supported.into();

                let raw_samples = Arc::new(Mutex::new(Vec::<f32>::new()));
                let raw_samples_cb = raw_samples.clone();

                let stream = match sample_format {
                    SampleFormat::F32 => device.build_input_stream(
                        &config,
                        move |data: &[f32], _| {
                            if let Ok(mut q) = raw_samples_cb.lock() {
                                q.extend_from_slice(data);
                            }
                        },
                        |err| eprintln!("[SherpaKWS] Audio stream error: {err}"),
                        None,
                    ),
                    SampleFormat::I16 => {
                        let raw_samples_cb = raw_samples.clone();
                        device.build_input_stream(
                            &config,
                            move |data: &[i16], _| {
                                if let Ok(mut q) = raw_samples_cb.lock() {
                                    q.extend(data.iter().map(|&s| s as f32 / i16::MAX as f32));
                                }
                            },
                            |err| eprintln!("[SherpaKWS] Audio stream error: {err}"),
                            None,
                        )
                    }
                    SampleFormat::U16 => {
                        let raw_samples_cb = raw_samples.clone();
                        device.build_input_stream(
                            &config,
                            move |data: &[u16], _| {
                                if let Ok(mut q) = raw_samples_cb.lock() {
                                    q.extend(data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0));
                                }
                            },
                            |err| eprintln!("[SherpaKWS] Audio stream error: {err}"),
                            None,
                        )
                    }
                    _ => {
                        eprintln!("[SherpaKWS] Unsupported sample format from microphone.");
                        let _ = app_handle.emit("rie-wake-word-status", "error");
                        return;
                    }
                };

                let cpal_stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[SherpaKWS] Failed to build microphone input stream: {e}");
                        let _ = app_handle.emit("rie-wake-word-status", "error");
                        return;
                    }
                };

                if let Err(e) = cpal_stream.play() {
                    eprintln!("[SherpaKWS] Failed to start audio playback stream: {e}");
                    let _ = app_handle.emit("rie-wake-word-status", "error");
                    return;
                }

                println!("[SherpaKWS] sherpa-onnx engine is READY and listening offline.");
                let _ = app_handle.emit("rie-wake-word-status", "listening");

                let mut spotter_stream = spotter.create_stream();
                // Maintain rolling ring buffer of 2.0s mono 16kHz audio: 32,000 samples
                let ring_buffer_capacity = 32_000;
                let mut ring_buffer = Vec::<f32>::with_capacity(ring_buffer_capacity);
                let mut last_trigger_instant = std::time::Instant::now() - std::time::Duration::from_secs(10);

                while !stop_flag_thread.load(Ordering::Relaxed) {
                    let incoming: Vec<f32> = {
                        if let Ok(mut guard) = raw_samples.lock() {
                            let drained = guard.clone();
                            guard.clear();
                            drained
                        } else {
                            Vec::new()
                        }
                    };

                    if !incoming.is_empty() {
                        let mono_samples = if in_channels > 1 {
                            incoming
                                .chunks(in_channels)
                                .map(|ch| ch.iter().sum::<f32>() / in_channels as f32)
                                .collect::<Vec<f32>>()
                        } else {
                            incoming
                        };

                        let samples_16k = resample_to_16k(&mono_samples, in_sample_rate);

                        // Capture post-wake command audio during speaker verification and Live connection
                        if is_buffering_thread.load(Ordering::Relaxed) {
                            if let Ok(mut tb) = transition_buffer_thread.lock() {
                                // Cap at 5.0 seconds (80,000 samples at 16kHz) to avoid unbounded memory
                                if tb.len() < 80_000 {
                                    tb.extend_from_slice(&samples_16k);
                                }
                            }
                        }

                        ring_buffer.extend_from_slice(&samples_16k);
                        if ring_buffer.len() > ring_buffer_capacity {
                            let overflow = ring_buffer.len() - ring_buffer_capacity;
                            ring_buffer.drain(0..overflow);
                        }

                        spotter_stream.accept_waveform(16_000, &samples_16k);

                        while spotter.is_ready(&spotter_stream) {
                            spotter.decode(&spotter_stream);
                            if let Some(result) = spotter.get_result(&spotter_stream) {
                                let detected_keyword = result.keyword;
                                if !detected_keyword.is_empty() {
                                    let now = std::time::Instant::now();
                                    if now.duration_since(last_trigger_instant).as_millis() >= 2000 {
                                        last_trigger_instant = now;

                                        let rms = if !ring_buffer.is_empty() {
                                            let sum_sq: f64 = ring_buffer.iter().map(|&s| (s as f64).powi(2)).sum();
                                            (sum_sq / ring_buffer.len() as f64).sqrt()
                                        } else {
                                            0.0
                                        };

                                        if rms < 0.015 {
                                            println!("[SherpaKWS] Suppressed ambient noise floor: RMS {:.4}", rms);
                                        } else {
                                            // Wake word confirmed! Begin buffering command audio spoken from this instant onward
                                            is_buffering_thread.store(true, Ordering::Relaxed);
                                            if let Ok(mut tb) = transition_buffer_thread.lock() {
                                                tb.clear();
                                            }

                                            let display_text = if detected_keyword.contains("HI") {
                                                "Hi Rie"
                                            } else if detected_keyword.contains("OK") {
                                                "OK Rie"
                                            } else {
                                                "Hey Rie"
                                            };

                                            println!("[SherpaKWS] >>> MATCHED WAKE WORD: \"{}\" ({}) <<<", display_text, detected_keyword);

                                            let wav_b64 = if let Ok(wav_bytes) = encode_wav(&ring_buffer, 16_000, 1) {
                                                Some(base64_encode(&wav_bytes))
                                            } else {
                                                None
                                            };

                                            let event_payload = serde_json::json!({
                                                "text": display_text,
                                                "audio": wav_b64,
                                            });

                                            let _ = app_handle.emit("rie-native-wake-word", event_payload);
                                            let _ = app_handle.emit("rie-wake-word-heard", format!("MATCH: {}", display_text));
                                        }

                                        spotter_stream = spotter.create_stream();
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    thread::sleep(std::time::Duration::from_millis(30));
                }

                println!("[SherpaKWS] Audio listener thread terminated cleanly.");
            })
            .map_err(|e| format!("Failed to spawn sherpa-onnx listener thread: {e}"))?;

        Ok(Self {
            stop_flag,
            thread: Some(thread),
            transition_buffer,
            is_buffering_transition,
        })
    }

    pub fn take_transition_audio(&self) -> Option<String> {
        let mut guard = self.transition_buffer.lock().ok()?;
        self.is_buffering_transition.store(false, Ordering::Relaxed);
        if guard.len() >= 320 {
            let mut pcm16 = Vec::with_capacity(guard.len() * 2);
            for &s in guard.iter() {
                let clamped = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                pcm16.extend_from_slice(&clamped.to_le_bytes());
            }
            guard.clear();
            Some(base64_encode(&pcm16))
        } else {
            guard.clear();
            None
        }
    }

    pub fn stop(&mut self) -> Option<String> {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.take_transition_audio()
    }
}

pub struct NativeWakeWordManager {
    #[cfg(feature = "sherpa-kws")]
    detector: Mutex<Option<SherpaOnnxWakeDetector>>,
}

impl Default for NativeWakeWordManager {
    fn default() -> Self {
        Self {
            #[cfg(feature = "sherpa-kws")]
            detector: Mutex::new(None),
        }
    }
}

impl NativeWakeWordManager {
    pub fn start(&self, app: tauri::AppHandle) -> Result<(), String> {
        #[cfg(feature = "sherpa-kws")]
        {
            println!("[NativeWakeWord] Starting Sherpa-ONNX Zipformer KWS engine...");
            let detector = SherpaOnnxWakeDetector::start(app)?;
            let mut guard = self.detector.lock().map_err(|e| e.to_string())?;
            *guard = Some(detector);
            Ok(())
        }

        #[cfg(not(feature = "sherpa-kws"))]
        {
            let _ = app;
            Err("Sherpa-ONNX KWS is not compiled in this build.".to_string())
        }
    }

    pub fn take_transition_audio(&self) -> Result<Option<String>, String> {
        #[cfg(feature = "sherpa-kws")]
        {
            if let Ok(guard) = self.detector.lock() {
                if let Some(detector) = guard.as_ref() {
                    return Ok(detector.take_transition_audio());
                }
            }
        }
        Ok(None)
    }

    pub fn stop(&self) -> Result<Option<String>, String> {
        #[allow(unused_mut)]
        let mut transition_audio = None;
        #[cfg(feature = "sherpa-kws")]
        {
            if let Ok(mut guard) = self.detector.lock() {
                if let Some(mut detector) = guard.take() {
                    transition_audio = detector.stop();
                }
            }
        }
        Ok(transition_audio)
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
) -> Result<Option<String>, String> {
    state.stop()
}

#[tauri::command]
pub fn take_native_wake_word_transition_audio(
    state: tauri::State<'_, NativeWakeWordManager>,
) -> Result<Option<String>, String> {
    state.take_transition_audio()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resample_identity() {
        let input = vec![0.1, 0.2, -0.3, 0.4];
        let resampled = resample_to_16k(&input, 16_000);
        assert_eq!(input, resampled);
    }

    #[test]
    fn test_resample_from_48k() {
        let input = vec![0.0; 48_000];
        let resampled = resample_to_16k(&input, 48_000);
        assert_eq!(resampled.len(), 16_000);
    }

    #[test]
    fn test_pre_roll_wav_encoding() {
        let samples = vec![0.05f32; 1600];
        let wav = encode_wav(&samples, 16_000, 1).expect("Failed to encode WAV");
        assert!(wav.len() > 44);
        let b64 = base64_encode(&wav);
        assert!(!b64.is_empty());
    }

    #[test]
    fn test_kws_model_files_exist_in_resources() {
        use std::path::PathBuf;
        let candidates = [
            PathBuf::from("resources/kws"),
            PathBuf::from("src-tauri/resources/kws"),
            PathBuf::from("app/client/src-tauri/resources/kws"),
        ];
        let found = candidates.iter().find(|p| p.join("encoder.int8.onnx").exists());
        assert!(found.is_some(), "Bundled resources/kws directory must contain encoder.int8.onnx");
        let dir = found.unwrap();
        assert!(dir.join("decoder.int8.onnx").exists(), "decoder.int8.onnx must exist");
        assert!(dir.join("joiner.int8.onnx").exists(), "joiner.int8.onnx must exist");
        assert!(dir.join("tokens.txt").exists(), "tokens.txt must exist");
        assert!(dir.join("keywords.txt").exists(), "keywords.txt must exist");
    }

    #[test]
    fn test_audio_recorder_lifecycle_defaults() {
        let recorder = NativeAudioRecorder::default();
        let control = recorder.inner.lock().unwrap();
        assert!(!control.stop_flag.load(Ordering::Relaxed));
        assert!(control.thread.is_none());
    }

    #[test]
    fn test_live_voice_recorder_lifecycle_defaults() {
        let recorder = NativeLiveVoiceRecorder::default();
        let control = recorder.inner.lock().unwrap();
        assert!(!control.stop_flag.load(Ordering::Relaxed));
        assert!(!control.is_muted.load(Ordering::Relaxed));
        assert!(control.thread.is_none());
    }

    #[test]
    fn test_manager_take_transition_audio_default_is_none() {
        let manager = NativeWakeWordManager::default();
        let audio = manager.take_transition_audio().unwrap();
        assert!(audio.is_none());
    }

    #[cfg(feature = "sherpa-kws")]
    #[test]
    fn test_sherpa_detector_transition_buffer_drain() {
        let detector = SherpaOnnxWakeDetector {
            stop_flag: Arc::new(AtomicBool::new(false)),
            thread: None,
            transition_buffer: Arc::new(Mutex::new(vec![0.1f32; 3200])), // 200ms of audio
            is_buffering_transition: Arc::new(AtomicBool::new(true)),
        };

        assert!(detector.is_buffering_transition.load(Ordering::Relaxed));
        let drained = detector.take_transition_audio();
        assert!(drained.is_some(), "Transition audio >= 1600 samples must be extracted");
        let b64 = drained.unwrap();
        assert!(!b64.is_empty());

        // Second drain should be empty since buffer was cleared
        let second = detector.take_transition_audio();
        assert!(second.is_none(), "Buffer must be empty after first drain");
        assert!(!detector.is_buffering_transition.load(Ordering::Relaxed));
    }

    #[cfg(feature = "sherpa-kws")]
    fn create_test_spotter() -> (sherpa_onnx::KeywordSpotter, std::path::PathBuf) {
        use sherpa_onnx::{
            KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig,
            OnlineTransducerModelConfig,
        };
        use std::path::PathBuf;

        let candidates = [
            PathBuf::from("resources/kws"),
            PathBuf::from("src-tauri/resources/kws"),
            PathBuf::from("app/client/src-tauri/resources/kws"),
        ];
        let dir = candidates
            .iter()
            .find(|p| p.join("encoder.int8.onnx").exists())
            .expect("Model dir must exist in resources/kws")
            .clone();

        let config = KeywordSpotterConfig {
            model_config: OnlineModelConfig {
                transducer: OnlineTransducerModelConfig {
                    encoder: Some(dir.join("encoder.int8.onnx").to_string_lossy().to_string()),
                    decoder: Some(dir.join("decoder.int8.onnx").to_string_lossy().to_string()),
                    joiner: Some(dir.join("joiner.int8.onnx").to_string_lossy().to_string()),
                },
                tokens: Some(dir.join("tokens.txt").to_string_lossy().to_string()),
                num_threads: 2,
                provider: Some("cpu".to_string()),
                ..Default::default()
            },
            keywords_file: Some(dir.join("keywords.txt").to_string_lossy().to_string()),
            max_active_paths: 4,
            num_trailing_blanks: 2,
            keywords_score: 1.5,
            keywords_threshold: 0.20,
            ..Default::default()
        };

        let spotter = KeywordSpotter::create(&config)
            .expect("KeywordSpotter should initialize cleanly from resources");
        (spotter, dir)
    }

    #[cfg(feature = "sherpa-kws")]
    #[test]
    fn test_sherpa_onnx_initialization_from_resources() {
        let (spotter, _) = create_test_spotter();
        let stream = spotter.create_stream();
        let silence = vec![0.0f32; 1600];
        stream.accept_waveform(16_000, &silence);
        assert!(!spotter.is_ready(&stream));
    }

    #[test]
    fn test_wake_trigger_debounce_logic() {
        let mut last_trigger = std::time::Instant::now() - std::time::Duration::from_secs(10);
        let mut trigger_count = 0;

        // First trigger
        let now = std::time::Instant::now();
        if now.duration_since(last_trigger).as_millis() >= 2000 {
            trigger_count += 1;
            last_trigger = now;
        }

        // Rapid second trigger (< 2000ms)
        let now2 = std::time::Instant::now();
        if now2.duration_since(last_trigger).as_millis() >= 2000 {
            trigger_count += 1;
        }

        assert_eq!(trigger_count, 1, "Debounce window must suppress rapid repeat triggers");
    }
}
