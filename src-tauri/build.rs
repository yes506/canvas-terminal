fn main() {
    // Ensure `../dist-dashboard/index.html` exists so `rust-embed` can compile
    // even when contributors run `cargo check` / `cargo build` directly without
    // first running `npm run build:dashboard`. The Tauri release flow always
    // builds the SPA first via beforeBuildCommand, so this stub is only ever
    // visible during raw-cargo dev cycles. Once the real Vite build runs, it
    // empties the dir (`emptyOutDir: true` in vite.dashboard.config.ts) and
    // writes the real bundle, replacing this placeholder.
    let dist = std::path::Path::new("../dist-dashboard");
    let index = dist.join("index.html");
    if !index.exists() {
        std::fs::create_dir_all(dist).expect("create dist-dashboard");
        std::fs::write(
            &index,
            "<!doctype html><meta charset=utf-8><title>Canvas Terminal Dashboard (stub)</title>\
             <body style=\"font-family:ui-monospace,monospace;background:#0a0a0a;color:#ddd;padding:2rem\">\
             <h1>Dashboard bundle not built</h1>\
             <p>Run <code>npm run build:dashboard</code> from the repo root, then reload.</p>",
        )
        .expect("write stub index.html");
    }
    println!("cargo:rerun-if-changed=../dist-dashboard");
    tauri_build::build()
}
