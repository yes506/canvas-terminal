use std::io::{Read, Write};

#[tauri::command]
pub fn save_canvas(path: String, data: String) -> Result<(), String> {
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_canvas(path: String) -> Result<String, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;
    Ok(contents)
}
