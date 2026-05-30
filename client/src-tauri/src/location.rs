use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct NativeLocationPayload {
    pub client_latitude: f64,
    pub client_longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_location_accuracy_m: Option<f64>,
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::NativeLocationPayload;
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};

    pub fn get_location() -> Result<NativeLocationPayload, String> {
        let access = Geolocator::RequestAccessAsync()
            .map_err(|e| format!("Location permission request failed: {e}"))?
            .get()
            .map_err(|e| format!("Location permission request failed: {e}"))?;

        if access != GeolocationAccessStatus::Allowed {
            return Err("Location access denied".to_string());
        }

        let locator = Geolocator::new().map_err(|e| format!("Geolocator init failed: {e}"))?;
        let _ = locator.SetDesiredAccuracy(PositionAccuracy::Default);

        let position = locator
            .GetGeopositionAsync()
            .map_err(|e| format!("Location read failed: {e}"))?
            .get()
            .map_err(|e| format!("Location read failed: {e}"))?;

        let coordinate = position
            .Coordinate()
            .map_err(|e| format!("Location coordinate failed: {e}"))?;
        let point = coordinate
            .Point()
            .map_err(|e| format!("Location point failed: {e}"))?;
        let pos = point
            .Position()
            .map_err(|e| format!("Location position failed: {e}"))?;

        let accuracy = coordinate.Accuracy().ok();

        Ok(NativeLocationPayload {
            client_latitude: pos.Latitude,
            client_longitude: pos.Longitude,
            client_location_accuracy_m: accuracy,
        })
    }
}

#[tauri::command]
pub fn get_native_location() -> Result<NativeLocationPayload, String> {
    #[cfg(target_os = "windows")]
    {
        return windows_impl::get_location();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = ();
        Err("Native location is only available on Windows".to_string())
    }
}
