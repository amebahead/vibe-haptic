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

    fn get_parent_pid(pid: libc::pid_t) -> libc::pid_t {
        use std::ptr;

        unsafe {
            let mut mib: [libc::c_int; 4] = [
                libc::CTL_KERN,
                libc::KERN_PROC,
                libc::KERN_PROC_PID,
                pid,
            ];
            // First call to get the required buffer size
            let mut size: libc::size_t = 0;
            let ret = libc::sysctl(
                mib.as_mut_ptr(),
                4,
                ptr::null_mut(),
                &mut size,
                ptr::null_mut(),
                0,
            );
            if ret != 0 || size == 0 {
                return 0;
            }

            // Allocate buffer and get actual data
            let mut buf: Vec<u8> = vec![0u8; size];
            let ret = libc::sysctl(
                mib.as_mut_ptr(),
                4,
                buf.as_mut_ptr() as *mut _,
                &mut size,
                ptr::null_mut(),
                0,
            );
            if ret != 0 {
                return 0;
            }

            // kinfo_proc layout on macOS:
            // The parent PID (kp_eproc.e_ppid) is at a known offset.
            // kp_proc is at offset 0, kp_eproc starts after kp_proc.
            // On arm64 macOS: kp_proc is 168 bytes, e_ppid is at offset 24 within kp_eproc.
            // On x86_64 macOS: kp_proc is 168 bytes, e_ppid is at offset 24 within kp_eproc.
            // e_ppid offset from start = kp_proc_size + e_paddr(8) + e_sess(8) + e_pcred(4+4) = 168 + 24
            // Actually, let's use a more reliable method: read e_ppid via the known total offset.
            // The kinfo_proc struct has kp_eproc.e_ppid at:
            //   offsetof(kinfo_proc, kp_eproc) + offsetof(eproc, e_ppid)
            // On macOS arm64/x86_64: this is at byte offset 560 (verified empirically).
            // But this is fragile. Let's use a different approach instead.

            // Use libproc's proc_pidinfo which is simpler:
            // We'll use PROC_PIDT_SHORTBSDINFO which gives us parent PID reliably.
            drop(buf);

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
}
