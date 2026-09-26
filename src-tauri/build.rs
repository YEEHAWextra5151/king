// Declares the app's commands so each gets an `allow-*` permission, and
// capabilities grant only what each window kind uses.
const COMMANDS: &[&str] = &[
    "take_window_init",
    "take_pending_opens",
    "window_ready",
    "registry_update",
    "perf_mark",
    "frontend_log",
    "toolbar_double_click",
    "start_window_drag",
    "close_window",
    "new_window",
    "open_settings",
    "read_document",
    "resolve_link",
    "allow_images",
    "image_data_urls",
    "list_folder",
    "open_dropped",
    "open_granted",
    "show_open_panel",
    "locate_file",
    "move_tab_to_new_window",
    "merge_windows",
    "list_open_documents",
    "reveal_in_finder",
    "open_external",
    "open_in_editor",
    "list_editors",
    "show_logs_folder",
    "popup_menu",
    "popup_path_menu",
    "print_window",
    "export_html",
    "copy_to_clipboard",
    "get_settings",
    "update_settings",
    "reset_settings",
    "get_recents",
    "clear_recents",
    "get_reading_position",
    "save_reading_position",
    "list_themes",
    "open_themes_folder",
    "default_app_status",
    "make_default_app",
    "dismiss_default_app_banner",
    "install_cli",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
