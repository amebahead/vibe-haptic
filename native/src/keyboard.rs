#[cfg(target_os = "macos")]
pub mod macos {
    use std::ffi::CStr;

    // Known terminal binary names
    const TERMINAL_NAMES: &[&str] = &[
        "Terminal",
        "iTerm2",
        "iTerm2-arm64",
        "Alacritty",
        "kitty",
        "WarpTerminal",
        "Warp",
        "Hyper",
        "tabby",
        "rio",
        "ghostty",
    ];

    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    pub fn is_accessibility_granted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn find_terminal_pid() -> Option<i32> {
        let mut pid = unsafe { libc::getpid() };

        // Walk up the process tree looking for a terminal
        loop {
            let ppid = get_parent_pid(pid);
            if ppid <= 1 {
                return None;
            }

            if let Some(name) = get_process_name(ppid) {
                if TERMINAL_NAMES.iter().any(|t| name.contains(t)) {
                    return Some(ppid);
                }
            }

            pid = ppid;
        }
    }

    #[repr(C)]
    struct ProcBsdShortInfo {
        pbsi_pid: u32,
        pbsi_ppid: u32,
        pbsi_pgid: u32,
        pbsi_status: u32,
        pbsi_comm: [u8; 16],
        pbsi_flags: u32,
        pbsi_uid: u32,
        pbsi_gid: u32,
        pbsi_ruid: u32,
        pbsi_rgid: u32,
        pbsi_svuid: u32,
        pbsi_svgid: u32,
        _reserved: u32,
    }

    const PROC_PIDT_SHORTBSDINFO: i32 = 13;

    fn get_parent_pid(pid: libc::pid_t) -> libc::pid_t {
        unsafe {
            let mut info: ProcBsdShortInfo = std::mem::zeroed();
            let size = libc::proc_pidinfo(
                pid,
                PROC_PIDT_SHORTBSDINFO,
                0,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<ProcBsdShortInfo>() as i32,
            );
            if size <= 0 {
                return 0;
            }
            info.pbsi_ppid as libc::pid_t
        }
    }

    fn get_process_name(pid: libc::pid_t) -> Option<String> {
        let mut buf = [0u8; 256];
        let ret = unsafe {
            libc::proc_name(pid, buf.as_mut_ptr() as *mut _, buf.len() as u32)
        };
        if ret <= 0 {
            return None;
        }
        let c_str = unsafe { CStr::from_ptr(buf.as_ptr() as *const _) };
        Some(c_str.to_string_lossy().into_owned())
    }

    // --- Keystroke injection ---

    use cocoa::appkit::NSApplicationActivationOptions;
    use cocoa::base::{id, nil};
    use core_graphics::event::{CGEvent, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc::{class, msg_send, sel, sel_impl};
    use std::thread;
    use std::time::Duration;

    use foreign_types::ForeignType;

    // CoreGraphics FFI for setting Unicode string on keyboard events
    extern "C" {
        fn CGEventKeyboardSetUnicodeString(
            event: *mut core_graphics::sys::CGEvent,
            string_length: u64,
            unicode_string: *const u16,
        );
    }

    /// Set the Unicode string on a CGEvent so terminals receive the correct character.
    fn set_event_unicode(event: &CGEvent, ch: char) {
        let mut buf = [0u16; 2];
        let encoded = ch.encode_utf16(&mut buf);
        let len = encoded.len() as u64;
        unsafe {
            CGEventKeyboardSetUnicodeString(
                event.as_ptr(),
                len,
                buf.as_ptr(),
            );
        }
    }

    fn keycode_for_char(c: char) -> Option<u16> {
        match c {
            'y' => Some(0x10),
            'n' => Some(0x2D),
            '1' => Some(0x12),
            '2' => Some(0x13),
            '3' => Some(0x14),
            _ => None,
        }
    }

    const RETURN_KEYCODE: u16 = 0x24;

    pub fn send_keystroke_to_terminal(terminal_pid: i32, key: &str) -> Result<(), String> {
        let keycode = key
            .chars()
            .next()
            .and_then(keycode_for_char)
            .ok_or_else(|| format!("Unsupported key: {}", key))?;

        unsafe {
            // 1. Activate terminal by PID (bring to front so CGEvent reaches it)
            let terminal_app: id = msg_send![
                class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: terminal_pid
            ];

            if terminal_app != nil {
                let _: () = msg_send![
                    terminal_app,
                    activateWithOptions: NSApplicationActivationOptions::NSApplicationActivateIgnoringOtherApps
                ];
                // Wait for terminal to fully gain focus
                thread::sleep(Duration::from_millis(150));
            }

            // 2. Create and post key events
            let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
                .map_err(|_| "Failed to create event source".to_string())?;

            // Key character — set Unicode string so terminals receive the correct char
            let key_char = key.chars().next().unwrap();
            let key_down = CGEvent::new_keyboard_event(source.clone(), keycode, true)
                .map_err(|_| "Failed to create key down event".to_string())?;
            set_event_unicode(&key_down, key_char);
            let key_up = CGEvent::new_keyboard_event(source.clone(), keycode, false)
                .map_err(|_| "Failed to create key up event".to_string())?;
            set_event_unicode(&key_up, key_char);
            key_down.post(CGEventTapLocation::HID);
            key_up.post(CGEventTapLocation::HID);

            // Wait for the character to be processed before sending Return
            thread::sleep(Duration::from_millis(30));

            // Return key
            let ret_down = CGEvent::new_keyboard_event(source.clone(), RETURN_KEYCODE, true)
                .map_err(|_| "Failed to create return down event".to_string())?;
            set_event_unicode(&ret_down, '\r');
            let ret_up = CGEvent::new_keyboard_event(source, RETURN_KEYCODE, false)
                .map_err(|_| "Failed to create return up event".to_string())?;
            set_event_unicode(&ret_up, '\r');
            ret_down.post(CGEventTapLocation::HID);
            ret_up.post(CGEventTapLocation::HID);

            // 3. Keep terminal focused — user wants to see the result
        }

        Ok(())
    }
}
