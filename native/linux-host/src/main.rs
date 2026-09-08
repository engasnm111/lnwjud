use std::io::{self, BufRead, Write};

use serde_json::Value;

mod atspi;
mod media;
mod remote_desktop_portal;
mod screencast_portal;
mod windows;
mod x11;
mod x11_input;

// The vision provider returns an 8 MiB-bounded PNG as base64, so the NDJSON
// envelope needs headroom for encoding and metadata while remaining bounded.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

fn response(id: &str, value: Option<&str>, error: Option<(&str, &str, bool)>) {
    let encoded = if let Some(value) = value {
        format!(r#"{{"id":"{}","ok":true,"value":{}}}"#, escape(id), value)
    } else if let Some((code, message, recoverable)) = error {
        format!(
            r#"{{"id":"{}","ok":false,"error":{{"code":"{}","message":"{}","recoverable":{}}}}}"#,
            escape(id),
            escape(code),
            escape(message),
            recoverable
        )
    } else {
        format!(
            r#"{{"id":"{}","ok":false,"error":{{"code":"INTERNAL_ERROR","message":"Native host response failed","recoverable":true}}}}"#,
            escape(id)
        )
    };
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{}", encoded);
    let _ = stdout.flush();
}

fn escape(value: &str) -> String {
    let encoded = serde_json::to_string(value).expect("JSON string serialization cannot fail");
    encoded
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or_default()
        .to_string()
}

fn operation_is_valid(operation: &str) -> bool {
    !operation.is_empty()
        && operation.len() <= 64
        && operation.chars().enumerate().all(|(index, value)| {
            if index == 0 {
                value.is_ascii_alphabetic()
            } else {
                value.is_ascii_alphanumeric() || matches!(value, '_' | '.' | '-')
            }
        })
}

fn operation_is_known(operation: &str) -> bool {
    matches!(
        operation,
        "health"
            | "accessibility"
            | "input_event"
            | "vision"
            | "window"
            | "audio"
            | "screen_record"
            | "office"
    )
}

fn dispatch_native_provider(
    operation: &str,
    line: &str,
) -> Option<Result<String, (&'static str, &'static str, bool)>> {
    if !matches!(
        operation,
        "accessibility" | "input_event" | "vision" | "window" | "audio" | "screen_record"
    ) {
        return None;
    }
    let (action, input) = match x11::request_input(line) {
        Ok(value) => value,
        Err(_) => {
            return Some(Err((
                "INVALID_INPUT",
                "Native host provider input is invalid",
                false,
            )))
        }
    };
    Some(match operation {
        "accessibility" => atspi::execute(&action, &input),
        "window" => windows::execute(&action, &input),
        "input_event" if session_type() == "wayland" => {
            if action == "status" {
                let portal_hint = env_present("XDG_DESKTOP_PORTAL_DIR")
                    || env_present("DBUS_SESSION_BUS_ADDRESS");
                Ok(remote_desktop_portal::status_json(true, portal_hint))
            } else {
                remote_desktop_portal::execute()
            }
        }
        "input_event" => x11_input::execute(&action, &input),
        "vision" => screencast_portal::execute(&action, &input),
        "audio" => media::audio_execute(&action, &input),
        "screen_record" => media::screen_record_execute(&action, &input),
        _ => unreachable!("operation was checked above"),
    })
}

fn env_present(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn session_type() -> &'static str {
    match std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "wayland" => "wayland",
        "x11" => "x11",
        _ if env_present("WAYLAND_DISPLAY") => "wayland",
        _ if env_present("DISPLAY") => "x11",
        _ if env_present("SSH_CONNECTION") || env_present("SSH_TTY") => "headless",
        _ => "unknown",
    }
}

fn executable_in_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|directory| {
        let candidate = directory.join(name);
        candidate.is_file()
    })
}

fn status_json_with_backend(
    backend: &str,
    available: bool,
    ready: bool,
    reason: Option<&str>,
    actions: &[&str],
) -> String {
    let action_json = actions
        .iter()
        .map(|action| format!(r#""{}""#, escape(action)))
        .collect::<Vec<_>>()
        .join(",");
    let reason_json = reason
        .map(|value| {
            format!(
                r#","reason":"{}","readinessReason":"{}""#,
                escape(value),
                escape(value)
            )
        })
        .unwrap_or_default();
    let permission_json = if reason == Some("portal_session_required") {
        r#","permissionState":"permission_required""#
    } else {
        ""
    };
    format!(
        r#"{{"available":{},"ready":{},"backend":"{}","supportedActions":[{}]{}{}}}"#,
        available,
        ready,
        escape(backend),
        action_json,
        reason_json,
        permission_json
    )
}

fn linux_health_json() -> String {
    let session = session_type();
    // XWayland commonly provides DISPLAY during a Wayland session.  The
    // session discriminator, rather than the socket's mere presence, is the
    // authority for advertising unrestricted X11 desktop semantics.
    let x11 = session == "x11";
    let x11_ready = x11 && x11::display_available();
    let wayland = session == "wayland";
    let dbus = env_present("DBUS_SESSION_BUS_ADDRESS");
    let atspi = env_present("AT_SPI_BUS_ADDRESS");
    let portal_hint = env_present("XDG_DESKTOP_PORTAL_DIR") || dbus;
    let office_hint = executable_in_path("soffice") || executable_in_path("libreoffice");
    let accessibility_status = atspi::status_json();
    let input_status = if wayland {
        remote_desktop_portal::status_json(wayland, portal_hint)
    } else {
        x11_input::status_json()
    };
    let vision_status =
        screencast_portal::status_json(wayland, portal_hint, x11::capture_available());
    let window_status = windows::status_json_for(x11_ready);
    let audio_status =
        media::audio_status(env_present("PIPEWIRE_REMOTE"), env_present("PULSE_SERVER"));
    let screen_record_status = media::screen_record_status(wayland, portal_hint, x11_ready);
    format!(
        r#"{{"platform":"linux","backend":"linux-native-host","available":true,"ready":true,"session":{{"type":"{}","x11":{},"wayland":{},"dbus":{},"portalHint":{},"atspi":{}}},"capabilities":{{"accessibility":{},"input_event":{},"vision":{},"window":{},"audio":{},"screen_record":{},"office":{}}}}}"#,
        escape(session),
        x11,
        wayland,
        dbus,
        portal_hint,
        atspi,
        accessibility_status,
        input_status,
        vision_status,
        window_status,
        audio_status,
        screen_record_status,
        status_json_with_backend(
            "libreoffice-uno",
            office_hint,
            false,
            if office_hint {
                Some("provider_not_implemented")
            } else {
                Some("dependency_missing")
            },
            &["status"]
        ),
    )
}

fn main() {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        if line.len() > MAX_PAYLOAD_BYTES {
            response(
                "unknown",
                None,
                Some((
                    "FILE_TOO_LARGE",
                    "Native host request exceeds the payload limit",
                    true,
                )),
            );
            continue;
        }
        let (id, operation) = match parse_envelope(&line) {
            Ok(value) => value,
            Err(message) => {
                response("unknown", None, Some(("INVALID_INPUT", message, false)));
                continue;
            }
        };
        if operation == "health" {
            let health = linux_health_json();
            response(&id, Some(&health), None);
        } else if let Some(result) = dispatch_native_provider(&operation, &line) {
            match result {
                Ok(value) => response(&id, Some(&value), None),
                Err(error) => response(&id, None, Some(error)),
            }
        } else {
            response(
                &id,
                Some(&format!(
                    r#"{{"platform":"linux","backend":"linux-native-host","operation":"{}","available":false,"ready":false,"local":true,"reason":"provider_not_implemented","readinessReason":"provider_not_implemented","deliveryState":"planned"}}"#,
                    escape(&operation)
                )),
                None,
            );
        }
    }
}

fn parse_envelope(line: &str) -> Result<(String, String), &'static str> {
    let value: Value =
        serde_json::from_str(line).map_err(|_| "Native host request is invalid JSON")?;
    let object = value
        .as_object()
        .ok_or("Native host request must be one JSON object")?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "operation" | "input" | "authorization"))
    {
        return Err("Native host request must contain only supported fields");
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Native host request id must be a non-empty string")?
        .to_string();
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .filter(|value| operation_is_valid(value))
        .ok_or("Native host operation is invalid")?
        .to_string();
    if !operation_is_known(&operation) {
        return Err("Native host operation is not supported");
    }
    Ok((id, operation))
}

#[cfg(test)]
mod tests {
    use super::{
        dispatch_native_provider, escape, operation_is_valid, parse_envelope,
        status_json_with_backend,
    };

    #[test]
    fn envelope_parser_allows_standard_json_whitespace_and_escaped_text() {
        let line = r#"{ "id" : "request-\"1", "operation" : "health", "input" : {"nested":true} }"#;
        assert_eq!(
            parse_envelope(line).expect("valid envelope"),
            ("request-\"1".to_string(), "health".to_string())
        );
    }

    #[test]
    fn malformed_or_missing_id_is_rejected_by_the_envelope_parser() {
        assert!(parse_envelope(r#"{"operation":"health"}"#).is_err());
        assert!(parse_envelope(r#"{"id":"x","operation":"health""#).is_err());
        assert!(parse_envelope(r#"{"id":"x","operation":"health","unexpected":true}"#).is_err());
        assert!(parse_envelope(r#"{"id":"x","operation":42}"#).is_err());
        assert!(operation_is_valid("screen_record"));
    }

    #[test]
    fn response_string_escaping_covers_json_control_characters() {
        let escaped = escape("quote\" slash\\ tab\t backspace\u{0008} formfeed\u{000c}");
        assert_eq!(
            escaped,
            "quote\\\" slash\\\\ tab\\t backspace\\b formfeed\\f"
        );
    }

    #[test]
    fn wayland_permission_status_is_valid_json_fragment() {
        let value = status_json_with_backend(
            "linux-native-host",
            false,
            false,
            Some("portal_session_required"),
            &["status"],
        );
        assert!(value.contains(r#","permissionState":"permission_required""#));
    }

    #[test]
    fn native_window_and_input_operations_are_routed_to_the_provider() {
        let line = r#"{"id":"x","operation":"window","input":{"action":"list"}}"#;
        assert!(dispatch_native_provider("window", line).is_some());
        assert!(dispatch_native_provider("vision", line).is_some());
        assert!(dispatch_native_provider("audio", line).is_some());
    }
}
