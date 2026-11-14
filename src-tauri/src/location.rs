//! The device's own location for the notch's weather, from the Windows
//! location service (Wi-Fi positioning, or GPS where the device has one). The
//! frontend falls back to IP geolocation when location access is off or no
//! fix arrives in time.

use serde::Serialize;
use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};
use windows::Foundation::TimeSpan;

/// A cached fix younger than this is good enough for the weather.
const MAX_AGE_SECS: i64 = 10 * 60;
/// Give up on a fresh fix after this long and let the frontend use IP lookup.
const TIMEOUT_SECS: i64 = 10;

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct DeviceLocation {
    pub lat: f64,
    pub lon: f64,
    /// Radius of uncertainty, in metres.
    pub accuracy_m: f64,
}

/// WinRT `TimeSpan` counts 100-nanosecond ticks.
fn seconds(secs: i64) -> TimeSpan {
    TimeSpan {
        Duration: secs * 10_000_000,
    }
}

fn location_sync() -> Result<DeviceLocation, String> {
    // Denied covers both the device-wide Location switch and the "Let desktop
    // apps access your location" switch in Settings > Privacy > Location.
    let access = Geolocator::RequestAccessAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("location access check failed: {e}"))?;
    if access != GeolocationAccessStatus::Allowed {
        return Err("location access is turned off in Windows".into());
    }

    let locator = Geolocator::new().map_err(|e| e.to_string())?;
    // City-level accuracy is plenty for weather and avoids waking a GPS.
    locator
        .SetDesiredAccuracy(PositionAccuracy::Default)
        .map_err(|e| e.to_string())?;
    let position = locator
        .GetGeopositionAsyncWithAgeAndTimeout(seconds(MAX_AGE_SECS), seconds(TIMEOUT_SECS))
        .and_then(|op| op.get())
        .map_err(|e| format!("no location fix: {e}"))?;
    let coordinate = position.Coordinate().map_err(|e| e.to_string())?;
    let point = coordinate
        .Point()
        .and_then(|p| p.Position())
        .map_err(|e| e.to_string())?;
    let accuracy_m = coordinate.Accuracy().unwrap_or(f64::NAN);

    if !valid_coordinates(point.Latitude, point.Longitude) {
        return Err("Windows returned invalid coordinates".into());
    }
    Ok(DeviceLocation {
        lat: point.Latitude,
        lon: point.Longitude,
        accuracy_m,
    })
}

/// Null Island (0, 0) is what an uninitialised fix looks like.
fn valid_coordinates(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
        && !(lat == 0.0 && lon == 0.0)
}

#[tauri::command]
pub async fn get_device_location() -> Result<DeviceLocation, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _com = crate::battery::ComGuard::new();
        location_sync()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timespan_counts_hundred_nanosecond_ticks() {
        assert_eq!(seconds(1).Duration, 10_000_000);
        assert_eq!(seconds(600).Duration, 6_000_000_000);
    }

    #[test]
    fn rejects_coordinates_that_are_not_a_real_fix() {
        assert!(valid_coordinates(-1.2921, 36.8219));
        assert!(valid_coordinates(90.0, -180.0));
        assert!(!valid_coordinates(0.0, 0.0));
        assert!(!valid_coordinates(91.0, 10.0));
        assert!(!valid_coordinates(10.0, 181.0));
        assert!(!valid_coordinates(f64::NAN, 10.0));
    }
}
