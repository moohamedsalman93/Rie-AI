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
