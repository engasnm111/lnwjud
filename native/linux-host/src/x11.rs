use std::collections::BTreeMap;
use std::fs;

use base64::Engine;
use serde_json::Value;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    self, Atom, AtomEnum, ConfigureWindowAux, ConnectionExt, ImageFormat, ImageOrder, Visualtype,
    Window,
};
use x11rb::protocol::xtest::ConnectionExt as XTestConnectionExt;
use x11rb::rust_connection::RustConnection;

const MAX_WINDOWS: usize = 256;
const MAX_INPUT_VALUE_BYTES: usize = 64 * 1024;
const MAX_CAPTURE_DIMENSION: u32 = 16_384;
const MAX_CAPTURE_PIXELS: u64 = 64_000_000;
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

/// Extract the bounded input object sent by `NativeHostProcessBridge` and
/// flatten scalar `parameters` into the map consumed by the provider. The
/// envelope parser in `main.rs` deliberately treats input as opaque; this
/// helper is the only place where provider input is decoded.
pub(crate) fn request_input(
    line: &str,
) -> Result<(String, BTreeMap<String, String>), &'static str> {
    let value: Value =
        serde_json::from_str(line).map_err(|_| "Native host input is invalid JSON")?;
    let object = value
        .as_object()
        .ok_or("Native host request must be a JSON object")?;
    let input = match object.get("input") {
        None => serde_json::Map::new(),
        Some(value) => value
            .as_object()
            .cloned()
            .ok_or("Native host provider input must be a JSON object")?,
    };
    if let Some(raw_action) = input.get("action").or_else(|| input.get("operation")) {
        if !raw_action.is_string() {
            return Err("Native host input action must be a string");
        }
    }
    let action = input
        .get("action")
        .and_then(Value::as_str)
        .or_else(|| input.get("operation").and_then(Value::as_str))
        .unwrap_or("status")
        .to_string();
    if action.is_empty()
        || action.len() > 64
        || !action.chars().enumerate().all(|(index, character)| {
            if index == 0 {
                character.is_ascii_alphabetic()
            } else {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
            }
        })
    {
        return Err("Native host input action is invalid");
    }

    let mut fields = BTreeMap::new();
    for (name, value) in &input {
        if name != "parameters" {
            flatten_scalar(&mut fields, name, value);
        }
    }
    if let Some(parameters) = input.get("parameters").and_then(Value::as_object) {
        for (name, value) in parameters {
            flatten_scalar(&mut fields, name, value);
        }
    }
    Ok((action, fields))
}

fn flatten_scalar(fields: &mut BTreeMap<String, String>, name: &str, value: &Value) {
    flatten_scalar_at_depth(fields, name, value, 0);
}

fn flatten_scalar_at_depth(
    fields: &mut BTreeMap<String, String>,
    name: &str,
    value: &Value,
    depth: usize,
) {
    if let Some(value) = scalar_text(value) {
        fields.insert(name.to_string(), value);
        return;
    }
    if depth >= 2 {
        return;
    }
    if let Some(object) = value.as_object() {
        for (child, value) in object {
            let key = format!("{}.{}", name, child);
            flatten_scalar_at_depth(fields, &key, value, depth + 1);
        }
    }
}

fn scalar_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()?
            .join(","),
        _ => return None,
    };
    (text.len() <= MAX_INPUT_VALUE_BYTES).then_some(text)
}

pub(crate) fn status_json() -> String {
    let display = x11_session();
    let connected = display && display_available();
    status_json_for_state(connected, connected && input_extension_available())
}

/// A Wayland desktop commonly exposes an XWayland `DISPLAY` for individual
/// applications.  That socket is not proof that the compositor grants the
/// unrestricted X11 desktop-control semantics this provider requires.  Keep
/// the X11 provider disabled whenever the explicit session type is Wayland.
pub(crate) fn x11_session() -> bool {
    x11_session_for(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var_os("DISPLAY").is_some_and(|value| !value.is_empty()),
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty()),
    )
}

fn x11_session_for(session_type: Option<&str>, display: bool, wayland_display: bool) -> bool {
    match session_type
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "wayland" => false,
        "x11" => true,
        _ => display && !wayland_display,
    }
}

/// Probe the active X11 socket instead of treating a non-empty DISPLAY as a
/// permission or readiness grant. This is intentionally read-only.
pub(crate) fn display_available() -> bool {
    x11_session()
        && std::env::var_os("DISPLAY").is_some_and(|value| !value.is_empty())
        && RustConnection::connect(None).is_ok()
}

/// A connected X11 socket is not enough to advertise capture readiness. Some
/// compositors expose an XWayland-compatible socket while rejecting
/// `GetImage`; probe one bounded pixel before reporting the capture provider as
/// ready.
pub(crate) fn capture_available() -> bool {
    if !display_available() {
        return false;
    }
    let Ok((conn, screen_num)) = RustConnection::connect(None) else {
        return false;
    };
    let Some(screen) = conn.setup().roots.get(screen_num) else {
        return false;
    };
    let Ok(cookie) = conn.get_image(ImageFormat::Z_PIXMAP, screen.root, 0, 0, 1, 1, u32::MAX)
    else {
        return false;
    };
    let Ok(reply) = cookie.reply() else {
        return false;
    };
    let Some(visual) = visual_for(&conn, reply.visual) else {
        return false;
    };
    decode_pixels(
        &reply.data,
        1,
        1,
        reply.data.len(),
        bytes_per_pixel(reply.depth),
        conn.setup().image_byte_order,
        visual,
    )
    .is_some()
}

#[cfg(test)]
pub(crate) fn status_json_for(display: bool) -> String {
    status_json_for_state(display, display)
}

fn status_json_for_state(display: bool, input_ready: bool) -> String {
    if display {
        if input_ready {
            r#"{"available":true,"ready":true,"backend":"x11","supportedActions":["status","list","get_active","get_bounds","get_display","activate","close","minimize","maximize","restore","move","resize","set_window_frame","mouse_move","click","double_click","right_click","scroll","press_key","key_down","key_up","hotkey","button_down","button_up","drag","type_text","paste_text","release_all"]}"#.to_string()
        } else {
            r#"{"available":true,"ready":false,"backend":"x11","reason":"dependency_missing","readinessReason":"dependency_missing","supportedActions":["status"]}"#.to_string()
        }
    } else {
        r#"{"available":false,"ready":false,"backend":"x11","reason":"dependency_missing","readinessReason":"dependency_missing","supportedActions":["status"]}"#.to_string()
    }
}

/// X11 connection success alone does not prove that synthetic input is
/// available. Probe the XTEST extension and negotiate its version before
/// advertising governed input actions.
pub(crate) fn input_extension_available() -> bool {
    let Ok((conn, _)) = RustConnection::connect(None) else {
        return false;
    };
    let Ok(cookie) = conn.query_extension(b"XTEST") else {
        return false;
    };
    let Ok(extension) = cookie.reply() else {
        return false;
    };
    if !extension.present {
        return false;
    }
    let Ok(version_cookie) = conn.xtest_get_version(2, 2) else {
        return false;
    };
    version_cookie.reply().is_ok()
}

pub(crate) fn execute(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if action == "status" {
        return Ok(status_json());
    }
    if !x11_session() {
        if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
            || std::env::var("XDG_SESSION_TYPE")
                .ok()
                .is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
        {
            return Err((
                "UNSUPPORTED_PLATFORM",
                "The active Wayland session requires a portal-backed provider; X11 desktop control is disabled",
                true,
            ));
        }
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "An active X11 DISPLAY is required for this operation",
            true,
        ));
    }
    if !std::env::var_os("DISPLAY").is_some_and(|value| !value.is_empty()) {
        if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty()) {
            return Err((
                "PERMISSION_REQUIRED",
                "This operation requires a portal-backed Wayland provider; the X11 session is unavailable",
                true,
            ));
        }
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "An active X11 DISPLAY is required for this operation",
            true,
        ));
    }
    let (conn, screen_num) = RustConnection::connect(None).map_err(|_| {
        (
            "PERMISSION_REQUIRED",
            "The X11 display could not be opened for the current session",
            true,
        )
    })?;
    let root = conn.setup().roots[screen_num].root;
    match action {
        "list" | "list_windows" => list_windows(&conn, root),
        "get_active" => active_window(&conn, root),
        "observe" | "observe_summary" => observe(&conn, root),
        "get_bounds" => bounds(&conn, root, input),
        "get_display" => display(&conn, screen_num),
        "activate" => {
            let window = selected_window(&conn, root, input)?;
            send_active_window(&conn, root, window)?;
            conn.flush().map_err(|_| {
                (
                    "INTERNAL_ERROR",
                    "X11 window activation could not be flushed",
                    true,
                )
            })?;
            Ok(format!(
                r#"{{"available":true,"ready":true,"activated":true,"window_id":{}}}"#,
                window
            ))
        }
        "close" | "minimize" | "maximize" | "restore" | "move" | "resize" | "set_window_frame" => {
            let window = selected_window(&conn, root, input)?;
            mutate_window(&conn, root, window, action, input)
        }
        "mouse_move" | "click" | "double_click" | "right_click" | "scroll" | "press_key"
        | "key_down" | "key_up" | "hotkey" | "button_down" | "button_up" | "drag" | "type_text"
        | "paste_text" | "release_all" => input_event(&conn, root, action, input),
        _ => Err((
            "UNSUPPORTED_PLATFORM",
            "This X11 operation is not implemented by the native host",
            true,
        )),
    }
}

fn list_windows(
    conn: &RustConnection,
    root: Window,
) -> Result<String, (&'static str, &'static str, bool)> {
    let client_list = intern_atom(conn, b"_NET_CLIENT_LIST")?;
    let windows = get_window_list(conn, root, client_list)?;
    let wm_name = intern_atom(conn, b"_NET_WM_NAME")?;
    let utf8 = intern_atom(conn, b"UTF8_STRING")?;
    let wm_pid = intern_atom(conn, b"_NET_WM_PID")?;
    let mut records = Vec::with_capacity(windows.len().min(MAX_WINDOWS));
    for window in windows.into_iter().take(MAX_WINDOWS) {
        let Ok(cookie) = conn.get_geometry(window) else {
            continue;
        };
        let Ok(geometry) = cookie.reply() else {
            continue;
        };
        let title = property_text(conn, window, wm_name, utf8).or_else(|| {
            property_text(
                conn,
                window,
                AtomEnum::WM_NAME.into(),
                AtomEnum::STRING.into(),
            )
        });
        let pid = property_u32(conn, window, wm_pid);
        let title_json = title
            .as_deref()
            .map(|value| format!(r#","title":"{}""#, escape(value)))
            .unwrap_or_default();
        let pid_json = pid
            .map(|value| format!(r#","pid":{}"#, value))
            .unwrap_or_default();
        records.push(format!(
            r#"{{"id":{},"bounds":{{"x":{},"y":{},"width":{},"height":{}}}{},{}}}"#,
            window, geometry.x, geometry.y, geometry.width, geometry.height, title_json, pid_json
        ));
    }
    Ok(format!(
        r#"{{"available":true,"ready":true,"windows":[{}]}}"#,
        records.join(",")
    ))
}

fn active_window(
    conn: &RustConnection,
    root: Window,
) -> Result<String, (&'static str, &'static str, bool)> {
    let atom = intern_atom(conn, b"_NET_ACTIVE_WINDOW")?;
    let cookie = conn
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, 1)
        .map_err(|_| ("INTERNAL_ERROR", "X11 active-window query failed", true))?;
    let value = cookie
        .reply()
        .map_err(|_| ("INTERNAL_ERROR", "X11 active-window query failed", true))?;
    let window = value.value32().and_then(|mut values| values.next());
    Ok(match window {
        Some(window) => format!(
            r#"{{"available":true,"ready":true,"window_id":{}}}"#,
            window
        ),
        None => r#"{"available":true,"ready":true,"window_id":null}"#.to_string(),
    })
}

fn observe(
    conn: &RustConnection,
    root: Window,
) -> Result<String, (&'static str, &'static str, bool)> {
    let active = active_window(conn, root)?;
    Ok(format!(
        r#"{{"available":true,"ready":true,"limited":true,"permission":"granted","active_window":{}}}"#,
        active
    ))
}

fn bounds(
    conn: &RustConnection,
    root: Window,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    let window = selected_window(conn, root, input)?;
    let cookie = conn.get_geometry(window).map_err(|_| {
        (
            "FILE_NOT_FOUND",
            "The requested X11 window was not found",
            true,
        )
    })?;
    let geometry = cookie.reply().map_err(|_| {
        (
            "FILE_NOT_FOUND",
            "The requested X11 window was not found",
            true,
        )
    })?;
    Ok(format!(
        r#"{{"available":true,"ready":true,"bounds":{{"x":{},"y":{},"width":{},"height":{}}}}}"#,
        geometry.x, geometry.y, geometry.width, geometry.height
    ))
}

fn display(
    conn: &RustConnection,
    screen_num: usize,
) -> Result<String, (&'static str, &'static str, bool)> {
    let screen = conn.setup().roots.get(screen_num).ok_or((
        "FILE_NOT_FOUND",
        "The X11 screen was not found",
        true,
    ))?;
    Ok(format!(
        r#"{{"available":true,"ready":true,"displays":[{{"index":{},"bounds":{{"x":0,"y":0,"width":{},"height":{}}},"scale_factor":1}}]}}"#,
        screen_num, screen.width_in_pixels, screen.height_in_pixels
    ))
}

/// Capture an X11 drawable into a bounded PNG payload. The native host keeps
/// this implementation local: no external screenshot utility or shell command
/// is involved, and the image is never written to disk.
pub(crate) fn capture(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if !x11_session() {
        if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
            || std::env::var("XDG_SESSION_TYPE")
                .ok()
                .is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
        {
            return Err((
                "UNSUPPORTED_PLATFORM",
                "The active Wayland session requires a portal-backed capture provider",
                true,
            ));
        }
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "An active X11 DISPLAY is required for capture",
            true,
        ));
    }
    if !std::env::var_os("DISPLAY").is_some_and(|value| !value.is_empty()) {
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "An active X11 DISPLAY is required for capture",
            true,
        ));
    }
    let (conn, screen_num) = RustConnection::connect(None).map_err(|_| {
        (
            "PERMISSION_REQUIRED",
            "The X11 display could not be opened for capture",
            true,
        )
    })?;
    let screen = conn.setup().roots.get(screen_num).ok_or((
        "FILE_NOT_FOUND",
        "The X11 screen was not found",
        true,
    ))?;
    let root = screen.root;
    match action {
        "capture_display" => capture_drawable(
            &conn,
            root,
            0,
            0,
            screen.width_in_pixels as u32,
            screen.height_in_pixels as u32,
        ),
        "capture_region" => {
            let x = parse_region_coordinate(input, "x")?;
            let y = parse_region_coordinate(input, "y")?;
            let width = parse_capture_dimension(input, "width")?;
            let height = parse_capture_dimension(input, "height")?;
            let right = i32::from(x) + i32::try_from(width).unwrap_or(i32::MAX);
            let bottom = i32::from(y) + i32::try_from(height).unwrap_or(i32::MAX);
            if x < 0
                || y < 0
                || right > i32::from(screen.width_in_pixels)
                || bottom > i32::from(screen.height_in_pixels)
            {
                return Err((
                    "INVALID_INPUT",
                    "X11 capture region is outside the current display",
                    false,
                ));
            }
            capture_drawable(&conn, root, x, y, width, height)
        }
        "capture_window" => {
            let window = selected_window(&conn, root, input)?;
            let geometry = conn
                .get_geometry(window)
                .map_err(|_| {
                    (
                        "FILE_NOT_FOUND",
                        "The requested X11 window was not found",
                        true,
                    )
                })?
                .reply()
                .map_err(|_| {
                    (
                        "FILE_NOT_FOUND",
                        "The requested X11 window was not found",
                        true,
                    )
                })?;
            capture_drawable(
                &conn,
                window,
                0,
                0,
                u32::from(geometry.width),
                u32::from(geometry.height),
            )
        }
        "ocr" | "annotate" => Err((
            "UNSUPPORTED_PLATFORM",
            "X11 capture is available, but OCR and annotation require an optional provider",
            true,
        )),
        _ => Err((
            "UNSUPPORTED_PLATFORM",
            "This X11 vision operation is not implemented by the native host",
            true,
        )),
    }
}

fn parse_capture_dimension(
    input: &BTreeMap<String, String>,
    name: &str,
) -> Result<u32, (&'static str, &'static str, bool)> {
    let value = input
        .get(name)
        .or_else(|| input.get(&format!("region.{name}")))
        .ok_or(("INVALID_INPUT", "Capture dimensions are required", false))?;
    let parsed = value.parse::<u32>().map_err(|_| {
        (
            "INVALID_INPUT",
            "Capture dimensions must be integers",
            false,
        )
    })?;
    if parsed == 0 || parsed > MAX_CAPTURE_DIMENSION {
        return Err((
            "INVALID_INPUT",
            "Capture dimensions are outside the allowed bounds",
            false,
        ));
    }
    Ok(parsed)
}

fn parse_region_coordinate(
    input: &BTreeMap<String, String>,
    name: &str,
) -> Result<i16, (&'static str, &'static str, bool)> {
    let value = input
        .get(name)
        .or_else(|| input.get(&format!("region.{name}")))
        .ok_or(("INVALID_INPUT", "Capture coordinates are required", false))?;
    let parsed = value.parse::<i32>().map_err(|_| {
        (
            "INVALID_INPUT",
            "Capture coordinates must be integers",
            false,
        )
    })?;
    i16::try_from(parsed)
        .map_err(|_| ("INVALID_INPUT", "Capture coordinate is out of range", false))
}

fn capture_dimensions(width: u32, height: u32) -> Result<(u32, u32), &'static str> {
    if width == 0
        || height == 0
        || width > MAX_CAPTURE_DIMENSION
        || height > MAX_CAPTURE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_CAPTURE_PIXELS
    {
        return Err("capture dimensions exceed the bounded image limits");
    }
    Ok((width, height))
}

fn capture_drawable(
    conn: &RustConnection,
    drawable: Window,
    x: i16,
    y: i16,
    width: u32,
    height: u32,
) -> Result<String, (&'static str, &'static str, bool)> {
    let (width, height) = capture_dimensions(width, height).map_err(|_| {
        (
            "INVALID_INPUT",
            "Capture dimensions are outside the allowed bounds",
            false,
        )
    })?;
    let width_u16 = u16::try_from(width).map_err(|_| {
        (
            "INVALID_INPUT",
            "Capture dimensions are outside the X11 range",
            false,
        )
    })?;
    let height_u16 = u16::try_from(height).map_err(|_| {
        (
            "INVALID_INPUT",
            "Capture dimensions are outside the X11 range",
            false,
        )
    })?;
    let reply = conn
        .get_image(
            ImageFormat::Z_PIXMAP,
            drawable,
            x,
            y,
            width_u16,
            height_u16,
            u32::MAX,
        )
        .map_err(|_| {
            (
                "PERMISSION_REQUIRED",
                "X11 capture request was rejected",
                true,
            )
        })?
        .reply()
        .map_err(|_| {
            (
                "PERMISSION_REQUIRED",
                "X11 capture request was rejected",
                true,
            )
        })?;
    let visual = visual_for(conn, reply.visual).ok_or((
        "UNSUPPORTED_PLATFORM",
        "The X11 visual format is not supported for capture",
        true,
    ))?;
    let row_stride = reply.data.len().checked_div(height as usize).ok_or((
        "INTERNAL_ERROR",
        "X11 capture returned no image rows",
        true,
    ))?;
    let bytes_per_pixel = bytes_per_pixel(reply.depth);
    if bytes_per_pixel == 0
        || row_stride < (width as usize).saturating_mul(bytes_per_pixel)
        || reply.data.len() > MAX_CAPTURE_BYTES.saturating_mul(4)
    {
        return Err((
            "UNSUPPORTED_PLATFORM",
            "The X11 pixel format is not supported for capture",
            true,
        ));
    }
    let rgba = decode_pixels(
        &reply.data,
        width as usize,
        height as usize,
        row_stride,
        bytes_per_pixel,
        conn.setup().image_byte_order,
        visual,
    )
    .ok_or((
        "UNSUPPORTED_PLATFORM",
        "The X11 pixel format is not supported for capture",
        true,
    ))?;
    let encoded = encode_rgba_png(width, height, &rgba).map_err(|_| {
        (
            "FILE_TOO_LARGE",
            "The captured X11 image exceeds the output limit",
            true,
        )
    })?;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(encoded);
    Ok(format!(
        r#"{{"available":true,"ready":true,"format":"png","mime_type":"image/png","data_base64":"{}","width":{},"height":{}}}"#,
        data_base64, width, height
    ))
}

fn bytes_per_pixel(depth: u8) -> usize {
    match depth {
        0..=8 => 1,
        9..=16 => 2,
        _ => 4,
    }
}

fn visual_for(conn: &RustConnection, visual_id: u32) -> Option<Visualtype> {
    conn.setup()
        .roots
        .iter()
        .flat_map(|screen| screen.allowed_depths.iter())
        .flat_map(|depth| depth.visuals.iter())
        .find(|visual| visual.visual_id == visual_id)
        .copied()
}

fn decode_pixels(
    data: &[u8],
    width: usize,
    height: usize,
    row_stride: usize,
    bytes_per_pixel: usize,
    byte_order: ImageOrder,
    visual: Visualtype,
) -> Option<Vec<u8>> {
    if visual.red_mask == 0 || visual.green_mask == 0 || visual.blue_mask == 0 {
        return None;
    }
    let pixels = width.checked_mul(height)?;
    let output_bytes = pixels.checked_mul(4)?;
    if output_bytes > MAX_CAPTURE_BYTES {
        return None;
    }
    let mut rgba = Vec::with_capacity(output_bytes);
    for row in 0..height {
        let row_start = row.checked_mul(row_stride)?;
        for column in 0..width {
            let offset = row_start.checked_add(column.checked_mul(bytes_per_pixel)?)?;
            let end = offset.checked_add(bytes_per_pixel)?;
            let pixel = data.get(offset..end)?;
            let raw = if byte_order == ImageOrder::LSB_FIRST {
                pixel
                    .iter()
                    .enumerate()
                    .fold(0_u32, |value, (index, byte)| {
                        value | (u32::from(*byte) << (index * 8))
                    })
            } else {
                pixel
                    .iter()
                    .fold(0_u32, |value, byte| (value << 8) | u32::from(*byte))
            };
            rgba.push(scale_component(raw, visual.red_mask));
            rgba.push(scale_component(raw, visual.green_mask));
            rgba.push(scale_component(raw, visual.blue_mask));
            rgba.push(255);
        }
    }
    Some(rgba)
}

fn scale_component(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let maximum = u64::from(mask >> shift);
    let value = u64::from((pixel & mask) >> shift);
    ((value * 255 + maximum / 2) / maximum).min(255) as u8
}

fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, ()> {
    let (width, height) = capture_dimensions(width, height).map_err(|_| ())?;
    let expected = usize::try_from(u64::from(width) * u64::from(height) * 4).map_err(|_| ())?;
    if rgba.len() != expected {
        return Err(());
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    {
        let mut writer = encoder.write_header().map_err(|_| ())?;
        writer.write_image_data(rgba).map_err(|_| ())?;
        writer.finish().map_err(|_| ())?;
    }
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Err(());
    }
    Ok(bytes)
}

fn screen_for_root(conn: &RustConnection, root: Window) -> Option<&xproto::Screen> {
    conn.setup().roots.iter().find(|screen| screen.root == root)
}

fn input_event(
    conn: &RustConnection,
    root: Window,
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if !input_extension_available_for_connection(conn) {
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "The active X11 session does not provide the XTEST input extension",
            true,
        ));
    }
    if action == "release_all" {
        conn.flush()
            .map_err(|_| ("INTERNAL_ERROR", "X11 input flush failed", true))?;
        return Ok(r#"{"available":true,"ready":true,"released":true}"#.to_string());
    }
    if matches!(
        action,
        "mouse_move" | "click" | "double_click" | "right_click"
    ) {
        let x = parse_i16(input, "x")?;
        let y = parse_i16(input, "y")?;
        let screen = screen_for_root(conn, root).ok_or((
            "FILE_NOT_FOUND",
            "The active X11 screen was not found",
            true,
        ))?;
        if x < 0
            || y < 0
            || x as u16 >= screen.width_in_pixels
            || y as u16 >= screen.height_in_pixels
        {
            return Err((
                "INVALID_INPUT",
                "X11 input coordinates are outside the current display",
                false,
            ));
        }
        conn.warp_pointer(0u32, root, 0, 0, 0, 0, x, y)
            .map_err(|_| ("INTERNAL_ERROR", "X11 pointer move failed", true))?;
        if action != "mouse_move" {
            let button = if action == "right_click" { 3 } else { 1 };
            fake_input(conn, xproto::BUTTON_PRESS_EVENT, button, root)?;
            fake_input(conn, xproto::BUTTON_RELEASE_EVENT, button, root)?;
            if action == "double_click" {
                fake_input(conn, xproto::BUTTON_PRESS_EVENT, button, root)?;
                fake_input(conn, xproto::BUTTON_RELEASE_EVENT, button, root)?;
            }
        }
    } else if matches!(action, "button_down" | "button_up") {
        let button = button_number(input)?;
        let event_type = if action == "button_down" {
            xproto::BUTTON_PRESS_EVENT
        } else {
            xproto::BUTTON_RELEASE_EVENT
        };
        fake_input(conn, event_type, button, root)?;
    } else if action == "drag" {
        let from_x = parse_i16(input, "from.x")?;
        let from_y = parse_i16(input, "from.y")?;
        let to_x = parse_i16(input, "to.x")?;
        let to_y = parse_i16(input, "to.y")?;
        let screen = screen_for_root(conn, root).ok_or((
            "FILE_NOT_FOUND",
            "The active X11 screen was not found",
            true,
        ))?;
        for (x, y) in [(from_x, from_y), (to_x, to_y)] {
            if x < 0
                || y < 0
                || x as u16 >= screen.width_in_pixels
                || y as u16 >= screen.height_in_pixels
            {
                return Err((
                    "INVALID_INPUT",
                    "X11 drag coordinates are outside the current display",
                    false,
                ));
            }
        }
        conn.warp_pointer(0u32, root, 0, 0, 0, 0, from_x, from_y)
            .map_err(|_| ("INTERNAL_ERROR", "X11 pointer move failed", true))?;
        fake_input(conn, xproto::BUTTON_PRESS_EVENT, 1, root)?;
        conn.warp_pointer(0u32, root, 0, 0, 0, 0, to_x, to_y)
            .map_err(|_| ("INTERNAL_ERROR", "X11 pointer move failed", true))?;
        fake_input(conn, xproto::BUTTON_RELEASE_EVENT, 1, root)?;
    } else if action == "scroll" {
        let delta = parse_i16(input, "delta_y")?;
        let button = if delta < 0 { 5 } else { 4 };
        for _ in 0..delta.unsigned_abs().min(120) {
            fake_input(conn, xproto::BUTTON_PRESS_EVENT, button, root)?;
            fake_input(conn, xproto::BUTTON_RELEASE_EVENT, button, root)?;
        }
    } else if matches!(action, "type_text" | "paste_text") {
        type_text(conn, root, input)?;
    } else if action == "sequence" {
        return Err((
            "UNSUPPORTED_PLATFORM",
            "X11 batched input is not implemented by this provider",
            true,
        ));
    } else if action == "hotkey" {
        let key = input
            .get("key")
            .ok_or(("INVALID_INPUT", "X11 key is required", false))?;
        let keycode = keycode(key).ok_or((
            "UNSUPPORTED_PLATFORM",
            "The requested key is not mapped by the X11 provider",
            true,
        ))?;
        let modifiers = input
            .get("modifiers")
            .map(|value| {
                value
                    .split(',')
                    .filter_map(modifier_keycode)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for modifier in &modifiers {
            fake_input(conn, xproto::KEY_PRESS_EVENT, *modifier, root)?;
        }
        fake_input(conn, xproto::KEY_PRESS_EVENT, keycode, root)?;
        fake_input(conn, xproto::KEY_RELEASE_EVENT, keycode, root)?;
        for modifier in modifiers.into_iter().rev() {
            fake_input(conn, xproto::KEY_RELEASE_EVENT, modifier, root)?;
        }
    } else {
        let key = input
            .get("key")
            .ok_or(("INVALID_INPUT", "X11 key is required", false))?;
        let keycode = keycode(key).ok_or((
            "UNSUPPORTED_PLATFORM",
            "The requested key is not mapped by the X11 provider",
            true,
        ))?;
        let event_type = if action == "key_up" {
            xproto::KEY_RELEASE_EVENT
        } else {
            xproto::KEY_PRESS_EVENT
        };
        fake_input(conn, event_type, keycode, root)?;
        if action == "press_key" {
            fake_input(conn, xproto::KEY_RELEASE_EVENT, keycode, root)?;
        }
    }
    conn.flush()
        .map_err(|_| ("INTERNAL_ERROR", "X11 input flush failed", true))?;
    Ok(r#"{"available":true,"ready":true,"dispatched":true}"#.to_string())
}

fn type_text(
    conn: &RustConnection,
    root: Window,
    input: &BTreeMap<String, String>,
) -> Result<(), (&'static str, &'static str, bool)> {
    let text = input
        .get("text")
        .ok_or(("INVALID_INPUT", "X11 text is required", false))?;
    if text.is_empty() || text.len() > MAX_INPUT_VALUE_BYTES {
        return Err((
            "INVALID_INPUT",
            "X11 text is empty or exceeds the input limit",
            false,
        ));
    }
    let mapping = keyboard_mapping(conn)?;
    let shift_keycode = mapping.shift_keycode;
    let mut strokes = Vec::with_capacity(text.chars().count());
    for character in text.chars() {
        let (keysym, needs_shift) = ascii_key_spec(character).ok_or((
            "UNSUPPORTED_PLATFORM",
            "X11 text input supports only characters present in the active keyboard layout",
            true,
        ))?;
        let keycode = mapping.find(keysym, needs_shift).ok_or((
            "UNSUPPORTED_PLATFORM",
            "The requested X11 text character is not mapped by the active keyboard layout",
            true,
        ))?;
        if needs_shift && shift_keycode.is_none() {
            return Err((
                "UNSUPPORTED_PLATFORM",
                "The active X11 keyboard layout has no Shift key mapping",
                true,
            ));
        }
        strokes.push((keycode, needs_shift));
    }
    for (keycode, needs_shift) in strokes {
        if needs_shift {
            fake_input(
                conn,
                xproto::KEY_PRESS_EVENT,
                shift_keycode.expect("validated Shift mapping"),
                root,
            )?;
        }
        fake_input(conn, xproto::KEY_PRESS_EVENT, keycode, root)?;
        fake_input(conn, xproto::KEY_RELEASE_EVENT, keycode, root)?;
        if needs_shift {
            fake_input(
                conn,
                xproto::KEY_RELEASE_EVENT,
                shift_keycode.expect("validated Shift mapping"),
                root,
            )?;
        }
    }
    Ok(())
}

struct KeyboardMapping {
    first_keycode: u8,
    keysyms_per_keycode: usize,
    keysyms: Vec<u32>,
    shift_keycode: Option<u8>,
}

impl KeyboardMapping {
    fn find(&self, keysym: u32, needs_shift: bool) -> Option<u8> {
        for (offset, chunk) in self.keysyms.chunks(self.keysyms_per_keycode).enumerate() {
            let level = if needs_shift { 1 } else { 0 };
            let expected = if needs_shift {
                shifted_keysym(keysym).unwrap_or(keysym)
            } else {
                keysym
            };
            if chunk.get(level).copied() == Some(expected)
                || (needs_shift && chunk.get(level).copied() == Some(keysym))
            {
                return self.first_keycode.checked_add(u8::try_from(offset).ok()?);
            }
        }
        None
    }
}

fn shifted_keysym(keysym: u32) -> Option<u32> {
    if (u32::from(b'a')..=u32::from(b'z')).contains(&keysym) {
        return Some(keysym - u32::from(b'a') + u32::from(b'A'));
    }
    Some(match keysym as u8 as char {
        '1' => '!',
        '2' => '@',
        '3' => '#',
        '4' => '$',
        '5' => '%',
        '6' => '^',
        '7' => '&',
        '8' => '*',
        '9' => '(',
        '0' => ')',
        '-' => '_',
        '=' => '+',
        '[' => '{',
        ']' => '}',
        '\\' => '|',
        ';' => ':',
        '\'' => '"',
        ',' => '<',
        '.' => '>',
        '/' => '?',
        '`' => '~',
        _ => return None,
    } as u32)
}

fn keyboard_mapping(
    conn: &RustConnection,
) -> Result<KeyboardMapping, (&'static str, &'static str, bool)> {
    let setup = conn.setup();
    let first_keycode = setup.min_keycode;
    let count = setup
        .max_keycode
        .saturating_sub(first_keycode)
        .saturating_add(1);
    let reply = conn
        .get_keyboard_mapping(first_keycode, count)
        .map_err(|_| {
            (
                "EXECUTABLE_NOT_FOUND",
                "X11 keyboard mapping is unavailable",
                true,
            )
        })?
        .reply()
        .map_err(|_| {
            (
                "EXECUTABLE_NOT_FOUND",
                "X11 keyboard mapping is unavailable",
                true,
            )
        })?;
    let keysyms_per_keycode = usize::from(reply.keysyms_per_keycode);
    if keysyms_per_keycode == 0 {
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "X11 keyboard mapping is empty",
            true,
        ));
    }
    let shift_keycode = find_keysym(&reply.keysyms, keysyms_per_keycode, first_keycode, 0xffe1)
        .or_else(|| find_keysym(&reply.keysyms, keysyms_per_keycode, first_keycode, 0xffe2));
    Ok(KeyboardMapping {
        first_keycode,
        keysyms_per_keycode,
        keysyms: reply.keysyms,
        shift_keycode,
    })
}

fn find_keysym(keysyms: &[u32], per_keycode: usize, first_keycode: u8, keysym: u32) -> Option<u8> {
    keysyms
        .chunks(per_keycode)
        .enumerate()
        .find(|(_, chunk)| chunk.first().copied() == Some(keysym))
        .and_then(|(offset, _)| first_keycode.checked_add(u8::try_from(offset).ok()?))
}

fn ascii_key_spec(character: char) -> Option<(u32, bool)> {
    if character.is_ascii_lowercase() || character.is_ascii_digit() || character == ' ' {
        return Some((character as u32, false));
    }
    if character.is_ascii_uppercase() {
        return Some((character.to_ascii_lowercase() as u32, true));
    }
    match character {
        '\n' | '\r' => Some((0xff0d, false)),
        '\t' => Some((0xff09, false)),
        '\u{8}' => Some((0xff08, false)),
        '!' => Some(('1' as u32, true)),
        '@' => Some(('2' as u32, true)),
        '#' => Some(('3' as u32, true)),
        '$' => Some(('4' as u32, true)),
        '%' => Some(('5' as u32, true)),
        '^' => Some(('6' as u32, true)),
        '&' => Some(('7' as u32, true)),
        '*' => Some(('8' as u32, true)),
        '(' => Some(('9' as u32, true)),
        ')' => Some(('0' as u32, true)),
        '_' => Some(('-' as u32, true)),
        '+' => Some(('=' as u32, true)),
        '{' => Some(('[' as u32, true)),
        '}' => Some((']' as u32, true)),
        '|' => Some(('\\' as u32, true)),
        ':' => Some((';' as u32, true)),
        '"' => Some(('\'' as u32, true)),
        '<' => Some((',' as u32, true)),
        '>' => Some(('.' as u32, true)),
        '?' => Some(('/' as u32, true)),
        '~' => Some(('`' as u32, true)),
        '-' | '=' | '[' | ']' | '\\' | ';' | '\'' | ',' | '.' | '/' | '`' => {
            Some((character as u32, false))
        }
        _ => None,
    }
}

fn input_extension_available_for_connection(conn: &RustConnection) -> bool {
    let Ok(cookie) = conn.query_extension(b"XTEST") else {
        return false;
    };
    let Ok(extension) = cookie.reply() else {
        return false;
    };
    if !extension.present {
        return false;
    }
    let Ok(version_cookie) = conn.xtest_get_version(2, 2) else {
        return false;
    };
    version_cookie.reply().is_ok()
}

fn fake_input(
    conn: &RustConnection,
    event_type: u8,
    detail: u8,
    root: Window,
) -> Result<(), (&'static str, &'static str, bool)> {
    let cookie = conn
        .xtest_fake_input(event_type, detail, 0, root, 0, 0, 0)
        .map_err(|_| {
            (
                "PERMISSION_REQUIRED",
                "X11 input injection was rejected",
                true,
            )
        })?;
    cookie.check().map_err(|_| {
        (
            "PERMISSION_REQUIRED",
            "X11 input injection was rejected",
            true,
        )
    })
}

fn send_active_window(
    conn: &RustConnection,
    root: Window,
    window: Window,
) -> Result<(), (&'static str, &'static str, bool)> {
    let active = intern_atom(conn, b"_NET_ACTIVE_WINDOW")?;
    send_client_message(conn, root, window, active, [1, 0, 0, 0, 0])
}

fn send_client_message(
    conn: &RustConnection,
    root: Window,
    window: Window,
    atom: Atom,
    data: [u32; 5],
) -> Result<(), (&'static str, &'static str, bool)> {
    let event = x11rb::protocol::xproto::ClientMessageEvent::new(32, window, atom, data);
    let cookie = conn
        .send_event(
            false,
            root,
            x11rb::protocol::xproto::EventMask::SUBSTRUCTURE_REDIRECT
                | x11rb::protocol::xproto::EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(|_| {
            (
                "PERMISSION_REQUIRED",
                "X11 window-manager request was rejected",
                true,
            )
        })?;
    cookie.check().map_err(|_| {
        (
            "PERMISSION_REQUIRED",
            "X11 window-manager request was rejected",
            true,
        )
    })
}

fn mutate_window(
    conn: &RustConnection,
    root: Window,
    window: Window,
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    match action {
        "close" => {
            let close = intern_atom(conn, b"_NET_CLOSE_WINDOW")?;
            send_client_message(conn, root, window, close, [0, 2, 0, 0, 0])?;
        }
        "minimize" => {
            let state = intern_atom(conn, b"_NET_WM_STATE")?;
            let hidden = intern_atom(conn, b"_NET_WM_STATE_HIDDEN")?;
            send_client_message(conn, root, window, state, [1, hidden, 0, 1, 0])?;
        }
        "maximize" | "restore" => {
            let state = intern_atom(conn, b"_NET_WM_STATE")?;
            let vertical = intern_atom(conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
            let horizontal = intern_atom(conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
            let mode = if action == "maximize" { 1 } else { 0 };
            send_client_message(
                conn,
                root,
                window,
                state,
                [mode, vertical, horizontal, 1, 0],
            )?;
            if action == "restore" {
                // EWMH window managers commonly represent a minimized
                // window with `_NET_WM_STATE_HIDDEN`. Removing only the
                // maximize states would leave that window hidden.
                let hidden = intern_atom(conn, b"_NET_WM_STATE_HIDDEN")?;
                send_client_message(conn, root, window, state, [0, hidden, 0, 1, 0])?;
            }
        }
        "move" | "resize" | "set_window_frame" => {
            let mut values = ConfigureWindowAux::new();
            if matches!(action, "move" | "set_window_frame") {
                values = values
                    .x(parse_i32_field(input, "x")?)
                    .y(parse_i32_field(input, "y")?);
            }
            if matches!(action, "resize" | "set_window_frame") {
                values = values
                    .width(parse_window_dimension(input, "width")?)
                    .height(parse_window_dimension(input, "height")?);
            }
            conn.configure_window(window, &values)
                .map_err(|_| {
                    (
                        "PERMISSION_REQUIRED",
                        "X11 window configuration was rejected",
                        true,
                    )
                })?
                .check()
                .map_err(|_| {
                    (
                        "PERMISSION_REQUIRED",
                        "X11 window configuration was rejected",
                        true,
                    )
                })?;
        }
        _ => {
            return Err((
                "UNSUPPORTED_PLATFORM",
                "This X11 window operation is not implemented by the native host",
                true,
            ));
        }
    }
    conn.flush().map_err(|_| {
        (
            "INTERNAL_ERROR",
            "X11 window operation could not be flushed",
            true,
        )
    })?;
    Ok(format!(
        r#"{{"available":true,"ready":true,"window_id":{},"action":"{}","dispatched":true}}"#,
        window,
        escape(action)
    ))
}

fn selected_window(
    conn: &RustConnection,
    root: Window,
    input: &BTreeMap<String, String>,
) -> Result<Window, (&'static str, &'static str, bool)> {
    let list = get_window_list(conn, root, intern_atom(conn, b"_NET_CLIENT_LIST")?)?;
    if let Some(value) = input.get("window_index") {
        let index = value
            .parse::<usize>()
            .map_err(|_| ("INVALID_INPUT", "window_index must be an integer", false))?;
        return list.get(index).copied().ok_or((
            "FILE_NOT_FOUND",
            "The requested X11 window was not found",
            true,
        ));
    }

    // The shared TypeScript schema calls a native window handle `hwnd` for
    // Windows compatibility. On X11 that selector is the unsigned 32-bit
    // window ID; accept the native `window_id` spelling as well, but resolve
    // it through the client list so a guessed/root window cannot be mutated.
    if input.contains_key("window_id") || input.contains_key("hwnd") {
        let key = if input.contains_key("window_id") {
            "window_id"
        } else {
            "hwnd"
        };
        let value = input.get(key).expect("selector key exists");
        let id = value.parse::<u64>().map_err(|_| {
            (
                "INVALID_INPUT",
                "window_id or hwnd must be an integer",
                false,
            )
        })?;
        let id = u32::try_from(id).map_err(|_| {
            (
                "INVALID_INPUT",
                "window_id or hwnd is outside the X11 range",
                false,
            )
        })?;
        return list
            .iter()
            .copied()
            .find(|candidate| *candidate == id)
            .ok_or((
                "FILE_NOT_FOUND",
                "The requested X11 window was not found",
                true,
            ));
    }

    let pid = input
        .get("pid")
        .or_else(|| input.get("process_id"))
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| ("INVALID_INPUT", "pid must be an integer", false))
        })
        .transpose()?;
    let title = input
        .get("title")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    let process_name = input
        .get("process_name")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    if pid.is_none() && title.is_none() && process_name.is_none() {
        return Err(("INVALID_INPUT", "A window selector is required", false));
    }

    let pid_atom = if pid.is_some() || process_name.is_some() {
        Some(intern_atom(conn, b"_NET_WM_PID")?)
    } else {
        None
    };
    let title_atoms = if title.is_some() {
        Some((
            intern_atom(conn, b"_NET_WM_NAME")?,
            intern_atom(conn, b"UTF8_STRING")?,
        ))
    } else {
        None
    };
    for window in list {
        let window_pid = pid_atom.and_then(|atom| property_u32(conn, window, atom));
        if pid.is_some() && window_pid != pid {
            continue;
        }
        if let Some(expected) = &process_name {
            let Some(window_pid) = window_pid else {
                continue;
            };
            let Some(actual) = process_name_for_pid(window_pid) else {
                continue;
            };
            if !actual.eq_ignore_ascii_case(expected) {
                continue;
            }
        }
        if let Some(expected) = &title {
            let Some((wm_name, utf8)) = title_atoms else {
                continue;
            };
            let actual = property_text(conn, window, wm_name, utf8).or_else(|| {
                property_text(
                    conn,
                    window,
                    AtomEnum::WM_NAME.into(),
                    AtomEnum::STRING.into(),
                )
            });
            let Some(actual) = actual else { continue };
            if !actual.to_lowercase().contains(&expected.to_lowercase()) {
                continue;
            }
        }
        return Ok(window);
    }
    Err((
        "FILE_NOT_FOUND",
        "The requested X11 window was not found",
        true,
    ))
}

fn get_window_list(
    conn: &RustConnection,
    root: Window,
    client_list: Atom,
) -> Result<Vec<Window>, (&'static str, &'static str, bool)> {
    let cookie = conn
        .get_property(
            false,
            root,
            client_list,
            AtomEnum::WINDOW,
            0,
            (MAX_WINDOWS * 2) as u32,
        )
        .map_err(|_| {
            (
                "EXECUTABLE_NOT_FOUND",
                "X11 window list is unavailable",
                true,
            )
        })?;
    let value = cookie.reply().map_err(|_| {
        (
            "EXECUTABLE_NOT_FOUND",
            "X11 window list is unavailable",
            true,
        )
    })?;
    Ok(value
        .value32()
        .map(|values| values.collect())
        .unwrap_or_default())
}

fn intern_atom(
    conn: &RustConnection,
    name: &[u8],
) -> Result<Atom, (&'static str, &'static str, bool)> {
    let cookie = conn
        .intern_atom(false, name)
        .map_err(|_| ("EXECUTABLE_NOT_FOUND", "X11 atom lookup failed", true))?;
    cookie
        .reply()
        .map(|reply| reply.atom)
        .map_err(|_| ("EXECUTABLE_NOT_FOUND", "X11 atom lookup failed", true))
}

fn property_text(conn: &RustConnection, window: Window, atom: Atom, type_: Atom) -> Option<String> {
    let reply = conn
        .get_property(false, window, atom, type_, 0, 512)
        .ok()?
        .reply()
        .ok()?;
    let value = String::from_utf8_lossy(&reply.value);
    let value = value.trim_end_matches('\0').trim();
    (!value.is_empty()).then(|| value.chars().take(512).collect())
}

fn property_u32(conn: &RustConnection, window: Window, atom: Atom) -> Option<u32> {
    conn.get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next()
}

fn process_name_for_pid(pid: u32) -> Option<String> {
    // `/proc/<pid>/comm` is a bounded, read-only kernel view and avoids
    // invoking a shell or trusting an unbounded command-line snapshot. The
    // PID came from the X11 `_NET_WM_PID` CARDINAL property, not user path
    // input, so the proc path cannot escape this metadata lookup.
    let value = fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.chars().take(256).collect())
}

fn parse_i16(
    input: &BTreeMap<String, String>,
    name: &str,
) -> Result<i16, (&'static str, &'static str, bool)> {
    let value =
        input
            .get(name)
            .ok_or(("INVALID_INPUT", "An input coordinate is required", false))?;
    let parsed = value
        .parse::<i32>()
        .map_err(|_| ("INVALID_INPUT", "Input coordinates must be integers", false))?;
    i16::try_from(parsed).map_err(|_| ("INVALID_INPUT", "Input coordinate is out of range", false))
}

fn parse_i32_field(
    input: &BTreeMap<String, String>,
    name: &str,
) -> Result<i32, (&'static str, &'static str, bool)> {
    let value =
        input
            .get(name)
            .ok_or(("INVALID_INPUT", "Window coordinates are required", false))?;
    value.parse::<i32>().map_err(|_| {
        (
            "INVALID_INPUT",
            "Window coordinates must be integers",
            false,
        )
    })
}

fn parse_window_dimension(
    input: &BTreeMap<String, String>,
    name: &str,
) -> Result<u32, (&'static str, &'static str, bool)> {
    let value =
        input
            .get(name)
            .ok_or(("INVALID_INPUT", "Window dimensions are required", false))?;
    let parsed = value
        .parse::<u32>()
        .map_err(|_| ("INVALID_INPUT", "Window dimensions must be integers", false))?;
    if parsed == 0 || parsed > MAX_CAPTURE_DIMENSION {
        return Err((
            "INVALID_INPUT",
            "Window dimensions are outside the allowed bounds",
            false,
        ));
    }
    Ok(parsed)
}

fn button_number(
    input: &BTreeMap<String, String>,
) -> Result<u8, (&'static str, &'static str, bool)> {
    let Some(value) = input.get("button") else {
        return Ok(1);
    };
    let normalized = value.trim().to_ascii_lowercase();
    let button = match normalized.as_str() {
        "left" | "primary" => Some(1),
        "middle" | "center" | "auxiliary" => Some(2),
        "right" | "secondary" => Some(3),
        _ => normalized.parse::<u8>().ok(),
    };
    match button.filter(|value| (1..=9).contains(value)) {
        Some(value) => Ok(value),
        None => Err((
            "INVALID_INPUT",
            "X11 mouse button must be a named button or an integer between 1 and 9",
            false,
        )),
    }
}

fn modifier_keycode(value: &str) -> Option<u8> {
    match value.trim().to_ascii_lowercase().as_str() {
        "shift" => Some(50),
        "control" | "ctrl" => Some(37),
        "alt" | "option" => Some(64),
        "super" | "command" | "cmd" | "meta" => Some(133),
        _ => None,
    }
}

fn keycode(value: &str) -> Option<u8> {
    let named = [
        ("return", 36),
        ("enter", 36),
        ("tab", 23),
        ("space", 65),
        ("escape", 9),
        ("esc", 9),
        ("backspace", 22),
        ("delete", 119),
        ("left", 113),
        ("right", 114),
        ("up", 111),
        ("down", 116),
    ];
    let normalized = value.to_ascii_lowercase();
    if let Some((_, code)) = named.iter().find(|(name, _)| *name == normalized) {
        return Some(*code);
    }
    value.parse::<u8>().ok().filter(|value| *value > 0)
}

fn escape(value: &str) -> String {
    let encoded = serde_json::to_string(value).expect("JSON string serialization cannot fail");
    encoded
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        ascii_key_spec, button_number, capture_dimensions, encode_rgba_png, escape, keycode,
        parse_i32_field, parse_region_coordinate, parse_window_dimension, request_input,
        status_json_for, x11_session_for,
    };

    #[test]
    fn x11_status_is_not_fake_ready_when_no_display_exists() {
        // Keep the contract test independent of the CI runner's ambient
        // DISPLAY/XWayland environment; status_json_for is the deterministic
        // no-display fixture used by the profile matrix.
        let value = status_json_for(false);
        assert!(value.contains(r#""available":false"#));
        assert!(value.contains(r#""ready":false"#));
    }

    #[test]
    fn x11_status_exposes_the_implemented_session_when_a_display_exists() {
        let value = status_json_for(true);
        assert!(value.contains(r#""available":true"#));
        assert!(value.contains(r#""ready":true"#));
        assert!(!value.contains("provider_not_implemented"));
    }

    #[test]
    fn wayland_session_does_not_inherit_xwayland_desktop_control() {
        assert!(!x11_session_for(Some("wayland"), true, true));
        assert!(!x11_session_for(Some("wayland"), true, false));
        assert!(x11_session_for(Some("x11"), true, true));
        assert!(x11_session_for(None, true, false));
        assert!(!x11_session_for(None, true, true));
    }

    #[test]
    fn key_mapping_is_bounded_to_known_or_numeric_keycodes() {
        assert_eq!(keycode("return"), Some(36));
        assert_eq!(keycode("255"), Some(255));
        assert_eq!(keycode("not-a-key"), None);
    }

    #[test]
    fn request_input_flattens_nested_scalar_parameters() {
        let line = r#"{"id":"x","operation":"input_event","input":{"operation":"click","parameters":{"x":120,"y":240,"text":"ok"}}}"#;
        let (action, fields) = request_input(line).expect("valid input");
        assert_eq!(action, "click");
        assert_eq!(fields.get("x").map(String::as_str), Some("120"));
        assert_eq!(fields.get("y").map(String::as_str), Some("240"));
        assert_eq!(fields.get("text").map(String::as_str), Some("ok"));
    }

    #[test]
    fn request_input_flattens_direct_nested_coordinates_for_drag() {
        let line = r#"{"id":"x","operation":"input_event","input":{"action":"drag","from":{"x":10,"y":20},"to":{"x":100,"y":200}}}"#;
        let (action, fields) = request_input(line).expect("valid input");
        assert_eq!(action, "drag");
        assert_eq!(fields.get("from.x").map(String::as_str), Some("10"));
        assert_eq!(fields.get("to.y").map(String::as_str), Some("200"));
    }

    #[test]
    fn request_input_rejects_non_object_provider_input() {
        let line = r#"{"id":"x","operation":"window","input":"not-an-object"}"#;
        assert!(request_input(line).is_err());
    }

    #[test]
    fn request_input_rejects_oversized_scalar_values() {
        let text = "x".repeat(65 * 1024);
        let line = format!(
            r#"{{"id":"x","operation":"input_event","input":{{"operation":"type_text","parameters":{{"text":"{}"}}}}}}"#,
            text
        );
        let (_, fields) = request_input(&line).expect("bounded request remains valid");
        assert!(!fields.contains_key("text"));
    }

    #[test]
    fn window_text_escaping_covers_json_control_characters() {
        let escaped = escape("title\twith\u{0008}controls");
        assert_eq!(escaped, "title\\twith\\bcontrols");
    }

    #[test]
    fn mouse_buttons_accept_names_and_reject_ambiguous_values() {
        let mut input = BTreeMap::new();
        input.insert("button".to_string(), "right".to_string());
        assert_eq!(button_number(&input).expect("right button"), 3);
        input.insert("button".to_string(), "not-a-button".to_string());
        assert!(button_number(&input).is_err());
    }

    #[test]
    fn rgba_png_encoder_emits_a_bounded_png_payload() {
        let encoded = encode_rgba_png(1, 1, &[255, 0, 128, 255]).expect("one pixel png");
        assert_eq!(&encoded[..8], b"\x89PNG\r\n\x1a\n");
        assert!(encoded.len() < 256);
    }

    #[test]
    fn capture_dimensions_reject_overflow_and_zero_values() {
        assert!(capture_dimensions(0, 1).is_err());
        assert!(capture_dimensions(1, 0).is_err());
        assert!(capture_dimensions(16_385, 1).is_err());
        assert!(capture_dimensions(1, 16_385).is_err());
        assert!(capture_dimensions(1_024, 768).is_ok());
    }

    #[test]
    fn region_coordinates_accept_the_nested_vision_schema() {
        let mut input = BTreeMap::new();
        input.insert("region.x".to_string(), "12".to_string());
        input.insert("region.y".to_string(), "34".to_string());
        assert_eq!(parse_region_coordinate(&input, "x").expect("x"), 12);
        assert_eq!(parse_region_coordinate(&input, "y").expect("y"), 34);
    }

    #[test]
    fn ascii_text_mapping_is_explicit_and_rejects_ambiguous_unicode() {
        assert_eq!(ascii_key_spec('a'), Some(('a' as u32, false)));
        assert_eq!(ascii_key_spec('A'), Some(('a' as u32, true)));
        assert_eq!(ascii_key_spec('!'), Some(('1' as u32, true)));
        assert_eq!(ascii_key_spec('\n'), Some((0xff0d, false)));
        assert_eq!(ascii_key_spec('中'), None);
    }

    #[test]
    fn window_mutation_dimensions_and_coordinates_are_bounded() {
        let mut input = BTreeMap::new();
        input.insert("x".to_string(), "-120".to_string());
        input.insert("width".to_string(), "1280".to_string());
        assert_eq!(parse_i32_field(&input, "x").expect("x"), -120);
        assert_eq!(
            parse_window_dimension(&input, "width").expect("width"),
            1280
        );
        input.insert("width".to_string(), "0".to_string());
        assert!(parse_window_dimension(&input, "width").is_err());
        input.insert("width".to_string(), "16385".to_string());
        assert!(parse_window_dimension(&input, "width").is_err());
    }
}
