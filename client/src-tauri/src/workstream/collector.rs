//! Workstream event collector and memory-bounded queue.
//! Batches events every 2-5 seconds and flushes via lightweight localhost HTTP POST.
//! Memory safety: bounded VecDeque (MAX_QUEUE = 1000) prevents memory leaks when backend is offline.
//! ZERO CRYPTO/TLS OVERHEAD: Uses pure standard library TcpStream for localhost communication.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use chrono::Utc;
use serde::{Deserialize, Serialize};

pub const MAX_QUEUE: usize = 1000;
pub const BATCH_MAX: usize = 50;
pub const FLUSH_INTERVAL_SECS: u64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEvent {
    pub timestamp: String,
    pub event_type: String,
    pub app_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    pub source: String,
    pub metadata: serde_json::Value,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardEvent {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    pub content: String,
    pub content_hash: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchEventsRequest {
    pub activity_events: Vec<ActivityEvent>,
    pub clipboard_events: Vec<ClipboardEvent>,
}

#[derive(Default)]
struct QueueState {
    activities: VecDeque<ActivityEvent>,
    clipboards: VecDeque<ClipboardEvent>,
}

#[derive(Clone)]
pub struct WorkstreamCollector {
    state: Arc<Mutex<QueueState>>,
}

impl WorkstreamCollector {
    pub fn new() -> Self {
        let collector = Self {
            state: Arc::new(Mutex::new(QueueState::default())),
        };

        // Start background flusher thread using pure standard library
        let flusher_clone = collector.clone();
        std::thread::Builder::new()
            .name("rie-workstream-flusher".into())
            .spawn(move || {
                flusher_clone.flusher_loop();
            })
            .ok();

        collector
    }

    pub fn push_activity(&self, event: ActivityEvent) {
        if let Ok(mut state) = self.state.lock() {
            if state.activities.len() >= MAX_QUEUE {
                // Drop oldest low-value event to maintain memory ceiling
                state.activities.pop_front();
            }
            state.activities.push_back(event);
        }
    }

    pub fn push_clipboard(&self, event: ClipboardEvent) {
        if let Ok(mut state) = self.state.lock() {
            if state.clipboards.len() >= MAX_QUEUE {
                state.clipboards.pop_front();
            }
            state.clipboards.push_back(event);
        }
    }

    fn drain_batch(&self) -> Option<BatchEventsRequest> {
        let mut state = self.state.lock().ok()?;
        if state.activities.is_empty() && state.clipboards.is_empty() {
            return None;
        }

        let mut act_batch = Vec::new();
        for _ in 0..BATCH_MAX {
            if let Some(item) = state.activities.pop_front() {
                act_batch.push(item);
            } else {
                break;
            }
        }

        let mut clip_batch = Vec::new();
        for _ in 0..BATCH_MAX {
            if let Some(item) = state.clipboards.pop_front() {
                clip_batch.push(item);
            } else {
                break;
            }
        }

        if act_batch.is_empty() && clip_batch.is_empty() {
            None
        } else {
            Some(BatchEventsRequest {
                activity_events: act_batch,
                clipboard_events: clip_batch,
            })
        }
    }

    fn flusher_loop(self) {
        loop {
            std::thread::sleep(Duration::from_secs(FLUSH_INTERVAL_SECS));

            while let Some(batch) = self.drain_batch() {
                let act_count = batch.activity_events.len();
                let clip_count = batch.clipboard_events.len();

                let json_body = match serde_json::to_vec(&batch) {
                    Ok(b) => b,
                    Err(_) => continue,
                };

                match post_to_backend("/workstream/events", &json_body) {
                    Ok(_) => {
                        println!(
                            "[Workstream] Flushed batch: {} activities, {} clipboards",
                            act_count, clip_count
                        );
                    }
                    Err(err) => {
                        eprintln!(
                            "[Workstream Collector] Could not reach backend: {}",
                            err
                        );
                        break;
                    }
                }
            }
        }
    }
}

/// Lightweight raw HTTP POST to localhost FastAPI server without external HTTP dependencies.
fn post_to_backend(path: &str, body: &[u8]) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(
        &"127.0.0.1:14300".parse().unwrap(),
        Duration::from_millis(500),
    )
    .map_err(|e| e.to_string())?;

    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let request_header = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:14300\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        body.len()
    );

    stream
        .write_all(request_header.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(body).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut response = [0u8; 128];
    let _ = stream.read(&mut response);

    Ok(())
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
