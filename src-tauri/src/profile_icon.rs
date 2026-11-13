//! Dock icons for browser profile items: the browser's logo with the
//! profile's avatar as a round badge in the bottom-right corner.
//!
//! Chromium browsers (Chrome, Edge, Brave) keep what this needs in each
//! profile folder once there are several profiles:
//! - `<X> Profile.ico`, the taskbar icon the browser draws itself: its logo
//!   with the avatar baked into one quarter. This is the only copy on disk of
//!   the browser's own default avatars (Chrome's silhouette in the profile's
//!   colors, Brave's avatar art); the originals live in its resource pack.
//! - `<X> Profile Picture.png`, the account photo, when the profile has one.
//!
//! Which of the two the browser shows is recorded in `User Data\Local State`.

use std::path::{Path, PathBuf};

use image::imageops::{self, FilterType};
use image::{Rgba, RgbaImage};

/// Edge length of the icons made here, in pixels.
pub const ICON_SIZE: u32 = 256;
/// Badge diameter as a share of the icon's edge. The browser's own badge is
/// half the icon too.
const BADGE_DIAMETER: f32 = 0.5;
/// Width of the transparent ring cut into the logo around the badge, as a
/// share of the icon's edge, so the avatar reads as a badge on the logo.
const BADGE_GAP: f32 = 0.03;
/// Largest image file read, in bytes. Edge account photos run to ~1.5 MB.
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
/// Largest `Local State` file read, in bytes.
const MAX_LOCAL_STATE_BYTES: u64 = 32 * 1024 * 1024;

/// The quarter of `<X> Profile.ico` a browser draws the avatar in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeCorner {
    TopRight,
    BottomLeft,
}

/// Where the browser of `exe_path` puts the avatar in its profile icon.
/// Measured by diffing the 256px frames of two profiles of one browser, which
/// differ only in the badge: a disc filling the top-right quarter in Chrome
/// and Brave, the bottom-left quarter in Edge.
pub fn badge_corner(exe_path: &str) -> BadgeCorner {
    if exe_path.to_lowercase().contains("msedge.exe") {
        BadgeCorner::BottomLeft
    } else {
        BadgeCorner::TopRight
    }
}

/// The avatar disc cut out of a browser's badged profile icon, as a square.
/// The crop is inset slightly so the logo the browser blended into the
/// disc's anti-aliased edge doesn't show as a fringe.
pub fn avatar_from_badged_icon(icon: &RgbaImage, corner: BadgeCorner) -> Option<RgbaImage> {
    let quarter = icon.width().min(icon.height()) / 2;
    let inset = (quarter / 64).max(1);
    let side = quarter.checked_sub(2 * inset).filter(|&side| side > 0)?;
    let (x, y) = match corner {
        BadgeCorner::TopRight => (icon.width() - quarter + inset, inset),
        BadgeCorner::BottomLeft => (inset, icon.height() - quarter + inset),
    };
    Some(imageops::crop_imm(icon, x, y, side, side).to_image())
}

/// The largest centered square of an image (account photos need not be square).
fn center_square(image: &RgbaImage) -> RgbaImage {
    let side = image.width().min(image.height());
    let x = (image.width() - side) / 2;
    let y = (image.height() - side) / 2;
    imageops::crop_imm(image, x, y, side, side).to_image()
}

/// How much of pixel (x, y) a disc covers, anti-aliased across one pixel.
fn disc_coverage(x: u32, y: u32, center: f32, radius: f32) -> f32 {
    let dx = x as f32 + 0.5 - center;
    let dy = y as f32 + 0.5 - center;
    (radius - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0)
}

/// `src`, faded to `coverage`, composited over `dst` (straight alpha).
fn over(src: Rgba<u8>, coverage: f32, dst: Rgba<u8>) -> Rgba<u8> {
    let sa = src[3] as f32 / 255.0 * coverage;
    let da = dst[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        return Rgba([0, 0, 0, 0]);
    }
    let channel = |i: usize| {
        ((src[i] as f32 * sa + dst[i] as f32 * da * (1.0 - sa)) / out_a)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    Rgba([
        channel(0),
        channel(1),
        channel(2),
        (out_a * 255.0).round() as u8,
    ])
}

/// `logo` with `avatar` as a round badge in the bottom-right corner, set off
/// from the logo by a thin transparent ring. Always `ICON_SIZE` square.
pub fn badge_icon(logo: &RgbaImage, avatar: &RgbaImage) -> RgbaImage {
    let size = ICON_SIZE;
    let mut out = if logo.dimensions() == (size, size) {
        logo.clone()
    } else {
        imageops::resize(logo, size, size, FilterType::Lanczos3)
    };
    let diameter = (size as f32 * BADGE_DIAMETER).round() as u32;
    let radius = diameter as f32 / 2.0;
    let gap = size as f32 * BADGE_GAP;
    // The badge's square touches the icon's bottom-right corner.
    let origin = size - diameter;
    let center = origin as f32 + radius;
    let avatar = imageops::resize(
        &center_square(avatar),
        diameter,
        diameter,
        FilterType::Lanczos3,
    );

    let start = (center - radius - gap - 1.0).floor().max(0.0) as u32;
    for y in start..size {
        for x in start..size {
            let knockout = disc_coverage(x, y, center, radius + gap);
            if knockout <= 0.0 {
                continue;
            }
            let dst = out.get_pixel_mut(x, y);
            dst[3] = (dst[3] as f32 * (1.0 - knockout)).round() as u8;
            let cover = disc_coverage(x, y, center, radius);
            if cover <= 0.0 || x < origin || y < origin {
                continue;
            }
            *dst = over(*avatar.get_pixel(x - origin, y - origin), cover, *dst);
        }
    }
    out
}

/// The profile's entry in `Local State` (`profile.info_cache.<dir>`).
pub fn profile_info<'a>(
    local_state: &'a serde_json::Value,
    profile_dir: &str,
) -> Option<&'a serde_json::Value> {
    local_state
        .get("profile")?
        .get("info_cache")?
        .as_object()?
        .iter()
        .find(|(dir, _)| dir.eq_ignore_ascii_case(profile_dir.trim()))
        .map(|(_, info)| info)
}

/// The account photo the browser shows for a profile, as a file name in the
/// profile folder; None when it shows one of its own avatars. Mirrors
/// Chromium's `ProfileAttributesEntry::IsUsingGAIAPicture`: the photo shows
/// when the user picked it, or when the avatar was never customized and the
/// profile has a photo. The caller falls back to the browser's avatar when
/// the file is missing, as the browser does.
pub fn account_photo_file(info: &serde_json::Value) -> Option<&str> {
    let file = info.get("gaia_picture_file_name")?.as_str()?.trim();
    if file.is_empty() || file.contains(['\\', '/']) || file.contains("..") {
        return None;
    }
    let flag = |key: &str| info.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    (flag("use_gaia_picture") || flag("is_using_default_avatar")).then_some(file)
}

/// The browser's default `User Data` folder.
fn default_user_data_dir(exe_path: &str) -> Option<PathBuf> {
    let exe = exe_path.to_lowercase();
    let user_data = if exe.contains("msedge.exe") {
        "Microsoft\\Edge\\User Data"
    } else if exe.contains("brave.exe") {
        "BraveSoftware\\Brave-Browser\\User Data"
    } else if exe.contains("chrome.exe") {
        "Google\\Chrome\\User Data"
    } else {
        return None;
    };
    Some(Path::new(&std::env::var("LOCALAPPDATA").ok()?).join(user_data))
}

/// The folder of one profile. The icon the browser gave the profile's window
/// lives in it, which also covers Beta, Canary and custom `User Data`
/// folders; a pin with no window uses the browser's default `User Data`.
pub fn profile_folder(
    exe_path: &str,
    profile_dir: &str,
    window_icon_file: Option<&str>,
) -> Option<PathBuf> {
    crate::commands::browser_profile_args(profile_dir)?;
    let profile_dir = profile_dir.trim();
    let beside_icon = window_icon_file
        .map(Path::new)
        .and_then(Path::parent)
        .filter(|folder| {
            folder
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(profile_dir))
        });
    match beside_icon {
        Some(folder) => Some(folder.to_path_buf()),
        None => Some(default_user_data_dir(exe_path)?.join(profile_dir)),
    }
}

/// The badged profile icon in a profile folder (`Google Profile.ico`,
/// `Edge Profile.ico`; Brave keeps Chrome's file name).
fn badged_icon_file(folder: &Path) -> Option<PathBuf> {
    std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.to_lowercase().ends_with(" profile.ico"))
        })
}

/// An image file as RGBA. A multi-size `.ico` yields its largest frame.
fn load_image(path: &Path) -> Option<RgbaImage> {
    if std::fs::metadata(path).ok()?.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(image::load_from_memory(&bytes).ok()?.to_rgba8())
}

fn read_local_state(user_data: &Path) -> Option<serde_json::Value> {
    let path = user_data.join("Local State");
    if std::fs::metadata(&path).ok()?.len() > MAX_LOCAL_STATE_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The dock icon of a browser profile: `logo` (the browser's own icon) with
/// the avatar the browser shows for the profile badged bottom-right. Without
/// a logo, the browser's own badged icon. None when the profile has neither
/// a photo nor a badged icon, so the caller falls back to the plain icon.
pub fn profile_dock_icon(
    logo: Option<RgbaImage>,
    exe_path: &str,
    profile_dir: &str,
    window_icon_file: Option<&str>,
) -> Option<RgbaImage> {
    let folder = profile_folder(exe_path, profile_dir, window_icon_file)?;
    let badged = window_icon_file
        .map(Path::new)
        .and_then(load_image)
        .or_else(|| badged_icon_file(&folder).as_deref().and_then(load_image));
    let photo = folder
        .parent()
        .and_then(read_local_state)
        .and_then(|state| {
            profile_info(&state, profile_dir)
                .and_then(account_photo_file)
                .map(|file| folder.join(file))
        })
        .and_then(|file| load_image(&file));
    let avatar = photo.or_else(|| {
        badged
            .as_ref()
            .and_then(|icon| avatar_from_badged_icon(icon, badge_corner(exe_path)))
    });
    match (logo, avatar) {
        (Some(logo), Some(avatar)) => Some(badge_icon(&logo, &avatar)),
        _ => badged,
    }
}

/// A PNG data URI, the form the dock shows icons in.
pub fn png_data_uri(image: &RgbaImage) -> Option<String> {
    use base64::Engine;
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// Decodes an image data URI (as `hbitmap_to_base64` returns) to RGBA.
pub fn image_from_data_uri(uri: &str) -> Option<RgbaImage> {
    use base64::Engine;
    let (_, data) = uri.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some(image::load_from_memory(&bytes).ok()?.to_rgba8())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RED: Rgba<u8> = Rgba([220, 40, 40, 255]);
    const BLUE: Rgba<u8> = Rgba([30, 90, 220, 255]);
    const GREEN: Rgba<u8> = Rgba([40, 180, 70, 255]);
    const YELLOW: Rgba<u8> = Rgba([240, 200, 30, 255]);

    fn solid(size: u32, color: Rgba<u8>) -> RgbaImage {
        RgbaImage::from_pixel(size, size, color)
    }

    /// A 256px stand-in for a badged profile icon: each quarter its own color.
    fn quarters() -> RgbaImage {
        RgbaImage::from_fn(256, 256, |x, y| match (x < 128, y < 128) {
            (true, true) => RED,
            (false, true) => BLUE,
            (true, false) => GREEN,
            (false, false) => YELLOW,
        })
    }

    fn close(a: Rgba<u8>, b: Rgba<u8>) -> bool {
        a.0.iter().zip(b.0.iter()).all(|(p, q)| p.abs_diff(*q) <= 2)
    }

    #[test]
    fn badge_corner_follows_the_browser() {
        let edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
        let chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        let brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
        assert_eq!(badge_corner(edge), BadgeCorner::BottomLeft);
        assert_eq!(badge_corner(chrome), BadgeCorner::TopRight);
        assert_eq!(badge_corner(brave), BadgeCorner::TopRight);
    }

    #[test]
    fn avatar_is_cut_from_the_badged_quarter() {
        let icon = quarters();
        let chrome = avatar_from_badged_icon(&icon, BadgeCorner::TopRight).unwrap();
        assert_eq!(chrome.dimensions(), (124, 124));
        assert!(chrome.pixels().all(|&p| p == BLUE));
        let edge = avatar_from_badged_icon(&icon, BadgeCorner::BottomLeft).unwrap();
        assert!(edge.pixels().all(|&p| p == GREEN));
        assert!(avatar_from_badged_icon(&solid(1, RED), BadgeCorner::TopRight).is_none());
    }

    #[test]
    fn badge_sits_bottom_right_with_a_clear_ring() {
        let icon = badge_icon(&solid(256, RED), &solid(64, BLUE));
        assert_eq!(icon.dimensions(), (ICON_SIZE, ICON_SIZE));
        // Badge center: the avatar.
        assert!(close(*icon.get_pixel(192, 192), BLUE));
        // Just outside the badge's edge, inside the ring: see-through.
        assert_eq!(icon.get_pixel(192, 192 - 64 - 4)[3], 0);
        assert_eq!(icon.get_pixel(192 - 64 - 4, 192)[3], 0);
        // The rest of the logo is untouched, including the far corners.
        assert_eq!(*icon.get_pixel(10, 10), RED);
        assert_eq!(*icon.get_pixel(250, 10), RED);
        assert_eq!(*icon.get_pixel(10, 250), RED);
        // The square's own corner lies outside the round badge.
        assert_eq!(*icon.get_pixel(255, 255), RED);
    }

    #[test]
    fn badge_edge_is_anti_aliased() {
        let icon = badge_icon(&solid(256, RED), &solid(64, BLUE));
        // Partial alpha where the ring meets the logo and the badge's rim.
        let partial: Vec<u32> = (100..192)
            .filter(|&y| (1..255).contains(&icon.get_pixel(192, y)[3]))
            .collect();
        assert!(partial.iter().any(|&y| y < 124), "logo side of the ring is hard-edged");
        assert!(partial.iter().any(|&y| y >= 124), "badge rim is hard-edged");
    }

    #[test]
    fn small_logos_are_scaled_up_and_photos_cropped_square() {
        // A 32px logo still gives a full-size icon.
        let icon = badge_icon(&solid(32, RED), &solid(10, BLUE));
        assert_eq!(icon.dimensions(), (ICON_SIZE, ICON_SIZE));
        assert!(close(*icon.get_pixel(20, 20), RED));
        // A wide photo is cropped to its middle, not squashed.
        let photo = RgbaImage::from_fn(300, 100, |x, _| if (100..200).contains(&x) { BLUE } else { GREEN });
        let icon = badge_icon(&solid(256, RED), &photo);
        assert!(close(*icon.get_pixel(150, 192), BLUE));
        assert!(close(*icon.get_pixel(235, 192), BLUE));
    }

    #[test]
    fn transparent_logo_pixels_stay_transparent_outside_the_badge() {
        let icon = badge_icon(&solid(256, Rgba([0, 0, 0, 0])), &solid(64, BLUE));
        assert_eq!(icon.get_pixel(20, 20)[3], 0);
        assert!(close(*icon.get_pixel(192, 192), BLUE));
    }

    #[test]
    fn photo_shows_when_picked_or_avatar_never_customized() {
        // Chrome: avatar never customized, account photo downloaded.
        let chrome = json!({
            "avatar_icon": "chrome://theme/IDR_PROFILE_AVATAR_26",
            "is_using_default_avatar": true,
            "gaia_picture_file_name": "Google Profile Picture.png"
        });
        assert_eq!(account_photo_file(&chrome), Some("Google Profile Picture.png"));
        // Edge: photo picked explicitly.
        let edge = json!({
            "use_gaia_picture": true,
            "is_using_default_avatar": false,
            "gaia_picture_file_name": "Edge Profile Picture.png"
        });
        assert_eq!(account_photo_file(&edge), Some("Edge Profile Picture.png"));
    }

    #[test]
    fn browser_avatar_shows_without_a_photo_or_when_one_was_chosen() {
        // No account photo (Chrome Profile 9, every Brave profile).
        let none = json!({ "is_using_default_avatar": true, "avatar_icon": "chrome://theme/IDR_PROFILE_AVATAR_71" });
        assert_eq!(account_photo_file(&none), None);
        // The user picked one of the browser's avatars over their photo.
        let picked = json!({
            "is_using_default_avatar": false,
            "gaia_picture_file_name": "Google Profile Picture.png"
        });
        assert_eq!(account_photo_file(&picked), None);
        // A file name that would leave the profile folder is never used.
        let escape = json!({ "use_gaia_picture": true, "gaia_picture_file_name": "..\\..\\x.png" });
        assert_eq!(account_photo_file(&escape), None);
    }

    #[test]
    fn finds_the_profile_entry_in_local_state() {
        let state = json!({ "profile": { "info_cache": {
            "Default": { "name": "Home" },
            "Profile 2": { "name": "Work" }
        }}});
        assert_eq!(profile_info(&state, "profile 2").unwrap()["name"], "Work");
        assert_eq!(profile_info(&state, "Default").unwrap()["name"], "Home");
        assert!(profile_info(&state, "Profile 3").is_none());
        assert!(profile_info(&json!({}), "Default").is_none());
    }

    #[test]
    fn profile_folder_prefers_the_window_icon_location() {
        let chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        let canary_icon =
            "C:\\Users\\me\\AppData\\Local\\Google\\Chrome SxS\\User Data\\Profile 2\\Google Profile.ico";
        assert_eq!(
            profile_folder(chrome, "Profile 2", Some(canary_icon)),
            Some(PathBuf::from(
                "C:\\Users\\me\\AppData\\Local\\Google\\Chrome SxS\\User Data\\Profile 2"
            ))
        );
        // An icon that is not in the profile's folder (the exe itself) is ignored.
        let folder = profile_folder(chrome, "Profile 2", Some(chrome)).unwrap();
        assert!(folder.ends_with("Google\\Chrome\\User Data\\Profile 2"));
        // A profile name that would escape User Data is refused.
        assert_eq!(profile_folder(chrome, "..\\..", None), None);
    }

    #[test]
    fn data_uri_round_trips() {
        let image = quarters();
        let uri = png_data_uri(&image).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
        assert_eq!(image_from_data_uri(&uri).unwrap(), image);
        assert!(image_from_data_uri("not a data uri").is_none());
    }
}
