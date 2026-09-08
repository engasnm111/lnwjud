use std::collections::BTreeMap;

pub(crate) fn status_json(wayland: bool, portal_hint: bool, x11: bool) -> String {
    if wayland {
        let reason = if portal_hint {
            "portal_session_required"
        } else {
            "dependency_missing"
        };
        return format!(
            r#"{{"available":true,"ready":false,"backend":"screencast-portal","supportedActions":["status","capture_display","capture_region","capture_window","ocr"],"reason":"{}","readinessReason":"{}","permissionState":"permission_required"}}"#,
            reason, reason
        );
    }
    if x11 {
        return r#"{"available":true,"ready":true,"backend":"x11-capture","supportedActions":["status","capture_display","capture_region","capture_window"],"optionalActions":["ocr","annotate"],"partial":true}"#.to_string();
    }
    r#"{"available":false,"ready":false,"backend":"screencast-portal","supportedActions":["status"],"reason":"dependency_missing","readinessReason":"dependency_missing"}"#.to_string()
}

pub(crate) fn execute(
    action: &str,
    _input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if action == "status" {
        return Ok(status_json(
            wayland_session(),
            std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|value| !value.is_empty()),
            super::x11::display_available(),
        ));
    }
    if wayland_session() {
        return Err((
            "PERMISSION_REQUIRED",
            "Wayland capture requires a visible ScreenCast portal session",
            true,
        ));
    }
    if super::x11::display_available() {
        return super::x11::capture(action, _input);
    }
    Err((
        "EXECUTABLE_NOT_FOUND",
        "A desktop capture session is unavailable on this host",
        true,
    ))
}

fn wayland_session() -> bool {
    wayland_session_for(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty()),
    )
}

fn wayland_session_for(session_type: Option<&str>, wayland_display: bool) -> bool {
    match session_type {
        Some(value) if value.eq_ignore_ascii_case("x11") => false,
        Some(value) if value.eq_ignore_ascii_case("wayland") => true,
        _ => wayland_display,
    }
}

#[cfg(test)]
mod tests {
    use super::{status_json, wayland_session_for};

    #[test]
    fn portal_capture_is_permission_gated() {
        let value = status_json(true, true, false);
        assert!(value.contains("portal_session_required"));
        assert!(value.contains(r#""permissionState":"permission_required"#));
    }

    #[test]
    fn x11_capture_advertises_only_the_implemented_provider_slice() {
        let value = status_json(false, false, true);
        assert!(value.contains(r#""ready":true"#));
        assert!(value.contains("capture_display"));
        assert!(value.contains("optionalActions"));
    }

    #[test]
    fn explicit_x11_session_wins_over_inherited_wayland_socket() {
        assert!(!wayland_session_for(Some("x11"), true));
        assert!(wayland_session_for(Some("wayland"), false));
        assert!(wayland_session_for(None, true));
    }
}
