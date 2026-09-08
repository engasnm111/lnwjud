use std::collections::BTreeMap;

use super::x11;

/// Thin operation boundary kept separate from window metadata so a future
/// Wayland RemoteDesktop provider can replace input without changing the
/// native-host envelope or the shared TypeScript capability contract.
pub(crate) fn status_json() -> String {
    x11::status_json()
}

pub(crate) fn execute(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    x11::execute(action, input)
}

#[cfg(test)]
mod tests {
    use crate::x11::status_json_for;

    #[test]
    fn input_status_names_the_x11_backend() {
        assert!(status_json_for(true).contains("backend"));
        assert!(status_json_for(true).contains("release_all"));
    }
}
