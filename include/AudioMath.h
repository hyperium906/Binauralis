#pragma once

#include <cmath>
#include <algorithm>

namespace AuraStream {

/**
 * @brief Acoustical constants and coordinate math for spatial audio.
 */
struct SphericalCoord {
    float azimuth_rad;    ///< Azimuth angle in radians [-pi, pi] (0 = front, +pi/2 = right, -pi/2 = left)
    float elevation_rad;  ///< Elevation angle in radians [-pi/2, pi/2] (0 = horizon, +pi/2 = up, -pi/2 = down)
    float distance_m;     ///< Radial distance in meters from listener origin
};

struct UnitVector3D {
    float x;
    float y;
    float z;
};

class AudioMath {
public:
    static constexpr float PI = 3.14159265358979323846f;
    static constexpr float TWO_PI = 6.28318530717958647692f;
    static constexpr float DEFAULT_MIN_DISTANCE = 0.5f;   ///< Clamping distance in meters
    static constexpr float DEFAULT_REF_DISTANCE = 1.0f;   ///< Reference distance in meters (unity gain)

    /**
     * @brief Convert Cartesian coordinates (listener at origin) to spherical.
     * Listener frame:
     *   +X = Right
     *   +Y = Forward
     *   +Z = Up
     */
    static inline SphericalCoord cartesian_to_spherical(float x, float y, float z) {
        const float dist_sq = x * x + y * y + z * z;
        const float dist = std::sqrt(dist_sq);
        const float eps = 1e-6f;

        SphericalCoord coord;
        coord.distance_m = dist;
        coord.azimuth_rad = std::atan2(x, y); // 0 at forward (+Y), +pi/2 at right (+X)
        
        if (dist > eps) {
            float norm_z = std::clamp(z / dist, -1.0f, 1.0f);
            coord.elevation_rad = std::asin(norm_z);
        } else {
            coord.elevation_rad = 0.0f;
        }

        return coord;
    }

    /**
     * @brief Convert spherical coordinates to normalized 3D unit vector.
     */
    static inline UnitVector3D spherical_to_unit_vector(float azimuth_rad, float elevation_rad) {
        const float cos_el = std::cos(elevation_rad);
        return UnitVector3D{
            std::sin(azimuth_rad) * cos_el,  // X (Right)
            std::cos(azimuth_rad) * cos_el,  // Y (Forward)
            std::sin(elevation_rad)          // Z (Up)
        };
    }

    /**
     * @brief Compute inverse-distance acoustic attenuation (power obeys inverse-square law).
     * @param distance_m Euclidean distance in meters.
     * @param min_distance_m Near-field clamping boundary.
     * @param ref_distance_m Reference distance where gain is 1.0.
     * @return Linear amplitude gain factor.
     */
    static inline float compute_distance_attenuation(
        float distance_m,
        float min_distance_m = DEFAULT_MIN_DISTANCE,
        float ref_distance_m = DEFAULT_REF_DISTANCE
    ) {
        const float clamped_dist = std::max(distance_m, min_distance_m);
        return ref_distance_m / clamped_dist;
    }

    /**
     * @brief 3D direction dot product (cosine of angle between two directions).
     */
    static inline float direction_similarity(const UnitVector3D& a, const UnitVector3D& b) {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }
};

} // namespace AuraStream
