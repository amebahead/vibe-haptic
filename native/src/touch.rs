#[cfg(target_os = "macos")]
pub mod macos {
    use napi::bindgen_prelude::*;
    use napi::threadsafe_function::{
        ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
    };
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // MultitouchSupport touch input FFI
    // MTTouch struct layout is reverse-engineered and opaque — we use num_fingers
    // from the callback parameters rather than parsing individual touch structs.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct MTTouch {
        _opaque: [u8; 128],
    }

    type MTDeviceRef = *mut c_void;

    // Wrapper for MTDeviceRef to implement Send+Sync.
    // Safety: MTDeviceRef is a pointer to a framework-managed device.
    // Access is serialized: main thread starts/stops, callback thread reads.
    pub struct DeviceHandle(pub *mut c_void);
    unsafe impl Send for DeviceHandle {}
    unsafe impl Sync for DeviceHandle {}

    type MTContactCallbackFunction = extern "C" fn(
        device: MTDeviceRef,
        data: *mut MTTouch,
        num_fingers: i32,
        timestamp: f64,
        frame: i32,
    );

    #[link(name = "MultitouchSupport", kind = "framework")]
    extern "C" {
        fn MTDeviceCreateList() -> *mut c_void; // Returns CFArrayRef
        fn MTDeviceStart(device: MTDeviceRef, mode: i32) -> i32;
        fn MTDeviceStop(device: MTDeviceRef) -> i32;
        fn MTRegisterContactFrameCallback(device: MTDeviceRef, callback: MTContactCallbackFunction);
    }

    // CoreFoundation array helpers
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, idx: isize) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    // Thread-safe global state for the C callback (MultitouchSupport doesn't support userdata)
    static GESTURE_STATE: Mutex<Option<GestureState>> = Mutex::new(None);

    struct GestureState {
        callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        stop_flag: Arc<AtomicBool>,
        prev_finger_count: i32,
        first_tap_time: Option<Instant>,
        tap_timeout: Duration,
    }

    extern "C" fn touch_callback(
        _device: MTDeviceRef,
        _data: *mut MTTouch,
        num_fingers: i32,
        _timestamp: f64,
        _frame: i32,
    ) {
        let mut guard = match GESTURE_STATE.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let state = match guard.as_mut() {
            Some(s) => s,
            None => return,
        };

        if state.stop_flag.load(Ordering::Relaxed) {
            return;
        }

        // Use num_fingers directly (more reliable than parsing MTTouch struct fields)
        let prev = state.prev_finger_count;
        state.prev_finger_count = num_fingers;

        // Detect 3-finger lift: was >=3 fingers, now <3
        if prev >= 3 && num_fingers < 3 {
            let is_double_tap = state
                .first_tap_time
                .map_or(false, |t| t.elapsed() < state.tap_timeout);

            if is_double_tap {
                // Second tap within window → double tap (no)
                state.first_tap_time = None;
                state.callback.call(
                    "double".to_string(),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            } else {
                // First tap (or previous tap expired)
                state.first_tap_time = Some(Instant::now());
                let timeout = state.tap_timeout;
                let stop_flag = state.stop_flag.clone();
                let cb = state.callback.clone();
                drop(guard); // Release lock before spawning
                schedule_single_tap_timer(timeout, stop_flag, cb);
            }
        }
    }

    fn schedule_single_tap_timer(
        timeout: Duration,
        stop_flag: Arc<AtomicBool>,
        cb: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) {
        let timeout_ms = timeout.as_millis() as u64;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(timeout_ms + 10));
            if stop_flag.load(Ordering::Relaxed) {
                return;
            }
            let mut guard = match GESTURE_STATE.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if let Some(state) = guard.as_mut() {
                if let Some(first_time) = state.first_tap_time {
                    if first_time.elapsed() >= timeout {
                        // Clear first_tap_time to prevent stale events
                        state.first_tap_time = None;
                        cb.call(
                            "single".to_string(),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                }
            }
        });
    }

    pub fn start_touch_listener(
        callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        tap_timeout_ms: u32,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Vec<DeviceHandle>> {
        let device_list = unsafe { MTDeviceCreateList() };
        if device_list.is_null() {
            return Err(Error::from_reason("No multitouch devices found"));
        }

        let count = unsafe { CFArrayGetCount(device_list) };
        if count == 0 {
            unsafe { CFRelease(device_list as *const c_void) };
            return Err(Error::from_reason("No multitouch devices found"));
        }

        {
            let mut guard = GESTURE_STATE
                .lock()
                .map_err(|_| Error::from_reason("Lock poisoned"))?;
            *guard = Some(GestureState {
                callback,
                stop_flag,
                prev_finger_count: 0,
                first_tap_time: None,
                tap_timeout: Duration::from_millis(tap_timeout_ms as u64),
            });
        }

        let mut devices = Vec::new();
        for i in 0..count {
            unsafe {
                let device = CFArrayGetValueAtIndex(device_list, i) as MTDeviceRef;
                MTRegisterContactFrameCallback(device, touch_callback);
                MTDeviceStart(device, 0);
                devices.push(DeviceHandle(device));
            }
        }

        unsafe { CFRelease(device_list as *const c_void) };

        Ok(devices)
    }

    pub fn stop_touch_listener(devices: &[DeviceHandle]) {
        for device in devices {
            unsafe {
                MTDeviceStop(device.0);
            }
        }
        if let Ok(mut guard) = GESTURE_STATE.lock() {
            *guard = None;
        }
    }
}
