use std::collections::BTreeMap;

use super::x11;

/// Window operations are session-owned. The first Linux slice uses the
/// EWMH/X11 metadata path; Wayland callers must wait for a portal/window
/// provider instead of receiving guessed coordinates.
pub(crate) fn status_json() -> String {
    status_json_for(x11::display_available())
}

pub(crate) fn status_json_for(display: bool) -> String {
    if display {
        r#"{"available":true,"ready":true,"backend":"x11-window","supportedActions":["status","list","get_active","get_bounds","get_display","activate","close","minimize","maximize","restore","move","resize","set_window_frame"]}"#.to_string()
    } else {
        r#"{"available":false,"ready":false,"backend":"x11-window","reason":"dependency_missing","readinessReason":"dependency_missing","supportedActions":["status"]}"#.to_string()
    }
}

pub(crate) fn execute(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if action == "status" {
        return Ok(status_json());
    }
    x11::execute(action, input)
}

#[cfg(test)]
mod tests {
    use super::status_json_for;

    #[test]
    fn window_status_requires_an_active_x11_display() {
        let value = status_json_for(false);
        assert!(value.contains(r#""available":false"#));
        assert!(value.contains("dependency_missing"));
    }
}
