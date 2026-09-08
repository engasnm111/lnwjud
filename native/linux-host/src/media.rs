use std::collections::BTreeMap;

pub(crate) fn audio_status(pipewire: bool, pulse: bool) -> String {
    if pipewire || pulse {
        return r#"{"available":true,"ready":false,"backend":"pipewire-pulse","supportedActions":["status"],"reason":"provider_not_implemented","readinessReason":"provider_not_implemented"}"#.to_string();
    }
    r#"{"available":false,"ready":false,"backend":"pipewire-pulse","supportedActions":["status"],"reason":"dependency_missing","readinessReason":"dependency_missing"}"#.to_string()
}

pub(crate) fn screen_record_status(wayland: bool, portal_hint: bool, x11: bool) -> String {
    if wayland {
        let reason = if portal_hint {
            "portal_session_required"
        } else {
            "dependency_missing"
        };
        return format!(
            r#"{{"available":true,"ready":false,"backend":"pipewire-screen-record","supportedActions":["status"],"reason":"{}","readinessReason":"{}","permissionState":"permission_required"}}"#,
            reason, reason
        );
    }
    if x11 {
        return r#"{"available":false,"ready":false,"backend":"pipewire-screen-record","supportedActions":["status"],"reason":"provider_not_implemented","readinessReason":"provider_not_implemented"}"#.to_string();
    }
    r#"{"available":false,"ready":false,"backend":"pipewire-screen-record","supportedActions":["status"],"reason":"dependency_missing","readinessReason":"dependency_missing"}"#.to_string()
}

pub(crate) fn audio_execute(
    action: &str,
    _input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if action == "status" {
        return Ok(audio_status(
            env_present("PIPEWIRE_REMOTE"),
            env_present("PULSE_SERVER"),
        ));
    }
    if env_present("PIPEWIRE_REMOTE") || env_present("PULSE_SERVER") {
        return Err((
            "UNSUPPORTED_PLATFORM",
            "Linux audio recording/playback is dependency-gated until an owned media provider is implemented",
            true,
        ));
    }
    Err((
        "EXECUTABLE_NOT_FOUND",
        "PipeWire or PulseAudio is unavailable on this host",
        true,
    ))
}

pub(crate) fn screen_record_execute(
    action: &str,
    _input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if action == "status" {
        return Ok(screen_record_status(
            wayland_session(),
            env_present("DBUS_SESSION_BUS_ADDRESS"),
            super::x11::display_available(),
        ));
    }
    if wayland_session() {
        return Err((
            "PERMISSION_REQUIRED",
            "Wayland screen recording requires a visible ScreenCast portal session",
            true,
        ));
    }
    if super::x11::display_available() {
        return Err((
            "UNSUPPORTED_PLATFORM",
            "Linux screen recording is dependency-gated until an owned PipeWire provider is implemented",
            true,
        ));
    }
    Err((
        "EXECUTABLE_NOT_FOUND",
        "A desktop screen-recording session is unavailable on this host",
        true,
    ))
}

fn env_present(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn wayland_session() -> bool {
    wayland_session_for(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        env_present("WAYLAND_DISPLAY"),
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
    use super::{audio_status, screen_record_status, wayland_session_for};

    #[test]
    fn media_dependencies_never_imply_ready_recording() {
        assert!(audio_status(true, false).contains(r#""ready":false"#));
        assert!(screen_record_status(true, true, false).contains("permissionState"));
    }

    #[test]
    fn explicit_x11_session_wins_over_inherited_wayland_socket() {
        assert!(!wayland_session_for(Some("x11"), true));
        assert!(wayland_session_for(Some("wayland"), false));
    }
}
