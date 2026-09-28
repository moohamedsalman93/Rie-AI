//! Idle detection using native Win32 GetLastInputInfo.
//! Emits idle_started and idle_ended state transitions rather than continuous polling spam.

use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleStateChange {
    BecameIdle { idle_seconds: u64 },
    BecameActive { idle_duration_seconds: u64 },
    None,
}

pub struct IdleTracker {
    idle_threshold_seconds: u64,
    is_idle: bool,
    idle_start_tick: u64,
}

impl IdleTracker {
    pub fn new(threshold_seconds: u64) -> Self {
        Self {
            idle_threshold_seconds: threshold_seconds,
            is_idle: false,
            idle_start_tick: 0,
        }
    }

    /// Evaluates current user input idle time.
    /// Call this periodically (e.g. every 2-5 seconds on timer).
    pub fn check(&mut self) -> IdleStateChange {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };

        let success = unsafe { GetLastInputInfo(&mut lii) };
        if !success.as_bool() {
            return IdleStateChange::None;
        }

        let current_tick = unsafe { GetTickCount64() };
        // dwTime is u32 tick count when input last happened.
        let elapsed_ms = (current_tick as u32).wrapping_sub(lii.dwTime);
        let idle_seconds = (elapsed_ms / 1000) as u64;

        if !self.is_idle && idle_seconds >= self.idle_threshold_seconds {
            self.is_idle = true;
            self.idle_start_tick = current_tick.saturating_sub(idle_seconds * 1000);
            IdleStateChange::BecameIdle { idle_seconds }
        } else if self.is_idle && idle_seconds < 2 {
            self.is_idle = false;
            let duration = current_tick.saturating_sub(self.idle_start_tick) / 1000;
            IdleStateChange::BecameActive {
                idle_duration_seconds: duration,
            }
        } else {
            IdleStateChange::None
        }
    }

    #[allow(dead_code)]
    pub fn is_currently_idle(&self) -> bool {
        self.is_idle
    }
}
