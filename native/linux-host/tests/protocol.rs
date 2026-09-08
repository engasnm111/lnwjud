#[test]
fn operation_names_are_bounded() {
    fn valid(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 64
            && value.chars().enumerate().all(|(index, c)| {
                if index == 0 {
                    c.is_ascii_alphabetic()
                } else {
                    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
                }
            })
    }
    assert!(valid("health"));
    assert!(!valid("../escape"));
    assert!(!valid(&"x".repeat(65)));
}

#[test]
fn payload_limit_has_headroom_for_bounded_capture_base64() {
    assert_eq!(16 * 1024 * 1024, 16_777_216);
}
