const ACTIONS: &[&str] = &[
    "status",
    "type_text",
    "press_key",
    "hotkey",
    "mouse_move",
    "click",
    "double_click",
    "right_click",
    "scroll",
    "drag",
    "release_all",
];

const MAX_PORTAL_COORDINATE: f64 = 1_000_000.0;

/// Parse a finite, bounded coordinate before it reaches a portal request.
/// Portal coordinates are untrusted input even though the current provider
/// only exposes status; keeping the parser here makes the eventual input
/// implementation use the same boundary as its tests.
pub(crate) fn parse_coordinate(value: &str) -> Option<f64> {
    let coordinate = value.trim().parse::<f64>().ok()?;
    coordinate
        .is_finite()
        .then_some(coordinate)
        .filter(|coordinate| coordinate.abs() <= MAX_PORTAL_COORDINATE)
}

/// Map the small set of evdev buttons supported by RemoteDesktop portals.
/// Numeric input is accepted only for those known codes; arbitrary button
/// values must never be forwarded to the native host.
pub(crate) fn parse_button(value: &str) -> Option<u32> {
    match value.trim().to_ascii_lowercase().as_str() {
        "left" | "272" => Some(272),
        "middle" | "273" => Some(273),
        "right" | "274" => Some(274),
        _ => None,
    }
}

/// Parse only explicit X11 keysyms needed by the portal adapter.  This is a
/// value parser, not a shell/command parser, and rejects unknown names.
pub(crate) fn parse_keysym(value: &str) -> Option<u32> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return None;
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return u32::from_str_radix(hex, 16).ok();
    }
    if trimmed.chars().count() == 1 && trimmed.is_ascii() {
        return trimmed.chars().next().map(u32::from);
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some(0xff0d),
        "tab" => Some(0xff09),
        "backspace" => Some(0xff08),
        "escape" | "esc" => Some(0xff1b),
        "space" => Some(0x20),
        "left" => Some(0xff51),
        "up" => Some(0xff52),
        "right" => Some(0xff53),
        "down" => Some(0xff54),
        _ => None,
    }
}

pub(crate) fn status_json(wayland: bool, portal_hint: bool) -> String {
    if !wayland {
        return r#"{"available":false,"ready":false,"backend":"remote-desktop-portal","reason":"unsupported_platform","readinessReason":"unsupported_platform","supportedActions":["status"]}"#.to_string();
    }
    let reason = if portal_hint {
        "portal_session_required"
    } else {
        "dependency_missing"
    };
    let actions = ACTIONS
        .iter()
        .map(|action| format!(r#""{}""#, action))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"available":true,"ready":false,"backend":"remote-desktop-portal","supportedActions":[{}],"reason":"{}","readinessReason":"{}","permissionState":"permission_required"}}"#,
        actions, reason, reason
    )
}

pub(crate) fn execute() -> Result<String, (&'static str, &'static str, bool)> {
    Err((
        "PERMISSION_REQUIRED",
        "Wayland control requires a visible RemoteDesktop portal session",
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::{parse_button, parse_coordinate, parse_keysym, status_json};

    #[test]
    fn wayland_portal_never_claims_unattended_readiness() {
        let value = status_json(true, true);
        assert!(value.contains(r#""ready":false"#));
        assert!(value.contains("permission_required"));
    }

    #[test]
    fn portal_input_parsers_reject_non_finite_or_unbounded_coordinates() {
        assert_eq!(parse_coordinate("12.5"), Some(12.5));
        assert_eq!(parse_coordinate("NaN"), None);
        assert_eq!(parse_coordinate("1000001"), None);
    }

    #[test]
    fn portal_button_parser_uses_evdev_codes_and_rejects_unknown_buttons() {
        assert_eq!(parse_button("left"), Some(272));
        assert_eq!(parse_button("right"), Some(274));
        assert_eq!(parse_button("middle"), Some(273));
        assert_eq!(parse_button("999"), None);
    }

    #[test]
    fn portal_key_parser_maps_ascii_and_named_keys_without_shells() {
        assert_eq!(parse_keysym("a"), Some(0x61));
        assert_eq!(parse_keysym("ENTER"), Some(0xff0d));
        assert_eq!(parse_keysym("0x41"), Some(0x41));
        assert_eq!(parse_keysym("not-a-key"), None);
    }
}
