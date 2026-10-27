//! Clipboard access for `clipboard:read` / `clipboard:write`.
//!
//! The renderer could reach `navigator.clipboard`, but WebView2 gates it behind
//! a permission prompt and it fails outright when the document is not focused —
//! which is exactly the state a background command runs in. Doing it in Rust
//! with the Win32 clipboard API keeps the behaviour deterministic and keeps the
//! capability list free of another plugin.
//!
//! Windows-only by design: the app ships as a Windows desktop build (see
//! `AGENTS.md`), and the other targets only need to compile.

/// `CF_UNICODETEXT` from `winuser.h`; spelled out because the constant lives in
/// a module this crate does not otherwise enable.
#[cfg(windows)]
const CF_UNICODETEXT: u32 = 13;

#[cfg(windows)]
#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    // The clipboard copies the buffer itself, but it insists on moveable global
    // memory: a plain Vec cannot be handed over.
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) };
    if handle.is_null() {
        return Err("E_CLIPBOARD: could not allocate clipboard memory".into());
    }
    let target = unsafe { GlobalLock(handle) } as *mut u16;
    if target.is_null() {
        unsafe { GlobalFree(handle) };
        return Err("E_CLIPBOARD: could not lock clipboard memory".into());
    }
    unsafe {
        ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
        GlobalUnlock(handle);
    }

    open_clipboard()?;
    unsafe {
        EmptyClipboard();
        // On success the clipboard owns the handle and must not be freed here.
        if SetClipboardData(CF_UNICODETEXT, handle).is_null() {
            GlobalFree(handle);
            CloseClipboard();
            return Err("E_CLIPBOARD: could not set clipboard data".into());
        }
        CloseClipboard();
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    open_clipboard()?;
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            CloseClipboard();
            return Ok(String::new());
        }
        let pointer = GlobalLock(handle) as *const u16;
        if pointer.is_null() {
            CloseClipboard();
            return Err("E_CLIPBOARD: could not lock clipboard memory".into());
        }
        let units = GlobalSize(handle) / std::mem::size_of::<u16>();
        let mut buffer: Vec<u16> = Vec::with_capacity(units);
        for index in 0..units {
            let unit = *pointer.add(index);
            if unit == 0 {
                break;
            }
            buffer.push(unit);
        }
        GlobalUnlock(handle);
        CloseClipboard();
        Ok(String::from_utf16_lossy(&buffer))
    }
}

/// The clipboard is a single-owner shared resource: another process can hold it
/// for a few milliseconds at a time. Retrying briefly is the documented remedy
/// and avoids a spurious failure when the user copies something at the same
/// instant a plugin writes.
#[cfg(windows)]
fn open_clipboard() -> Result<(), String> {
    use std::ptr;
    use windows_sys::Win32::System::DataExchange::OpenClipboard;

    for _ in 0..10 {
        if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err("E_CLIPBOARD: another application is holding the clipboard".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_write(_text: String) -> Result<(), String> {
    Err("E_UNSUPPORTED: clipboard access is only implemented on Windows".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    Err("E_UNSUPPORTED: clipboard access is only implemented on Windows".into())
}
