/// User-facing version. Cargo represents the fourth numeric component as build metadata.
pub const VERSION: &str = "1.2.39.2";

#[cfg(test)]
mod tests {
    use super::VERSION;

    #[test]
    fn exposes_release_display_version() {
        assert_eq!(VERSION, "1.2.39.2");
    }
}
