mod git;

use std::path::Path;

#[tauri::command]
fn open_repository(path: String) -> Result<git::Repository, String> {
    git::open_repository(&path)
}

#[tauri::command]
fn choose_repository() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Open Git repository")
        .pick_folder()
        .map(|path| path.display().to_string())
}

#[tauri::command]
fn compare_branches(path: String, base: String, head: String) -> Result<git::Comparison, String> {
    git::compare(&path, &base, &head)
}

#[tauri::command]
fn get_file_diff(
    path: String,
    base: String,
    head: String,
    file_path: String,
) -> Result<git::FileDiff, String> {
    git::file_diff(&path, &base, &head, &file_path)
}

#[tauri::command]
fn get_file_contents(
    path: String,
    revision: String,
    file_path: String,
) -> Result<git::FileContents, String> {
    git::file_contents(&path, &revision, &file_path)
}

#[tauri::command]
fn startup_path() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|path| Path::new(path).is_dir())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_repository,
            choose_repository,
            compare_branches,
            get_file_diff,
            get_file_contents,
            startup_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Diffie");
}
