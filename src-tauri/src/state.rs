use portable_pty::{Child, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::thread::JoinHandle;

pub struct PtySession {
    // Drop order matters: child first, then writer, then reader thread (join), then master last.
    // Rust drops fields in declaration order, but we use an explicit Drop impl for safety.
    pub child: Box<dyn Child + Send + Sync>,
    pub writer: Box<dyn Write + Send>,
    pub reader_thread: Option<JoinHandle<()>>,
    pub master: Box<dyn MasterPty + Send>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // 1. Kill child process — causes PTY to send EOF/EIO to reader
        let _ = self.child.kill();
        // 2. Drop writer — closes write end of PTY
        // (writer is dropped automatically after this fn, but we want ordering clarity)
        // 3. Join reader thread — wait for it to finish reading before dropping master
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
        // 4. master drops automatically last (declared last in struct)
    }
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}
