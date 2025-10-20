# 📏 Measurement Tools Guide

## Overview

Professional measurement tools with real-time distance, area, and bearing calculations displayed directly on the map.

## Features

### 📏 **Distance Measurement (Polyline)**

Draw a line to measure distance:

- **Yellow labels** on each segment showing distance in meters/kilometers
- **Total length** calculated automatically
- **Bearing** displayed for 2-point lines (e.g., "45.3° (NE)")
- Multi-segment support for complex paths

**Example Output:**

```
Segment 1: 84.37 m
Segment 2: 22.19 m
Total: 106.56 m
Bearing: 45.3° (NE)
```

### 📐 **Area Measurement (Polygon)**

Draw a polygon to measure area:

- **Yellow labels** on each side showing distance
- **Large yellow label** in center showing total area
- Area displayed in:
  - **m²** (square meters) for areas < 10,000 m²
  - **ha** (hectares) for areas 10,000 m² - 1,000,000 m²
  - **km²** (square kilometers) for areas > 1,000,000 m²

**Example Output:**

```
Side 1: 19.21 m
Side 2: 22.19 m
Side 3: 15.67 m
Side 4: 27.31 m
Area: 418.53 m²
```

### ⬜ **Rectangle Measurement**

Draw a rectangle:

- Distance labels on all 4 sides
- Area displayed in center
- Perfect for measuring rectangular plots

### 📍 **Point Marker**

Place a marker:

- Shows coordinates on hover
- Latitude and Longitude to 6 decimal places

## How to Use

### 1. **Select Drawing Tool**

Click the drawing toolbar on the top-left of the map:

- 📏 **Line** - Measure distance and bearing
- 📐 **Polygon** - Measure area and perimeter
- ⬜ **Rectangle** - Quick rectangular area
- 📍 **Marker** - Place point with coordinates

### 2. **Draw on Map**

- **Click** to add points
- **Double-click** or click first point again to finish
- Measurements appear **automatically**

### 3. **View Measurements**

- **Yellow labels** show on each segment
- **Area** displayed in polygon center
- Labels stay visible when zooming/panning

### 4. **Edit Measurements**

- Click **Edit** button (pencil icon)
- Drag points to adjust shape
- Measurements **update automatically**

### 5. **Save/Export**

- All drawings auto-save to browser
- Click **💾 Export** to download as GeoJSON
- Import into QGIS, ArcGIS, etc.

### 6. **Delete**

- Click **Delete** button (trash icon)
- Select shapes to remove
- Or click **🗑️ Clear** to remove all

## Calculation Methods

### Distance (Haversine Formula)

Accurate great-circle distance between coordinates:

```
d = 2r × arcsin(√(sin²(Δφ/2) + cos(φ1) × cos(φ2) × sin²(Δλ/2)))
```

Where:

- r = Earth's radius (6,371 km)
- φ = latitude
- λ = longitude

### Area (Shoelace Formula)

Spherical polygon area on Earth's surface:

```
A = |Σ(xi × sin(yj) - xj × sin(yi))| × r² / 2
```

### Bearing

Direction from north (0°-360°):

```
θ = atan2(sin(Δλ) × cos(φ2), cos(φ1) × sin(φ2) - sin(φ1) × cos(φ2) × cos(Δλ))
```

## Accuracy

- **Distance**: Accurate to centimeters for short distances
- **Area**: Accounts for Earth's curvature
- **Coordinates**: 6 decimal places (~0.11m precision)

## Tips

1. **For straight lines**: Use 2 points to get bearing
2. **For complex areas**: Use polygon with multiple points
3. **Quick rectangles**: Use rectangle tool for speed
4. **Zoom in**: For more precise measurements
5. **Edit mode**: Adjust points after drawing
6. **Labels persist**: Measurements stay visible across sessions

## Keyboard Shortcuts

- **Escape** - Cancel current drawing
- **Delete** - While editing, remove selected shape
- **Ctrl+Z** - Undo (browser dependent)

## Console Output

Drawing creates console logs:

```
📏 Line drawn: 106.56 m
   └─ Bearing: 45.3° (NE)

📐 Polygon drawn: 418.53 m²
   └─ Perimeter: 84.37 m

⬜ Rectangle drawn: 418.53 m²
```

## Visual Style

- **Background**: Yellow (`#fbbf24`)
- **Text**: Dark brown (`#78350f`)
- **Border**: Orange (`#f59e0b`)
- **Font**: Bold, 11-13px
- **Shadow**: Subtle for readability

## Comparison with GIS-Main

Matches the reference implementation:

- ✅ Yellow labels on each side
- ✅ Area in center
- ✅ Distance in meters
- ✅ No popups (always visible)
- ✅ Professional appearance
- ✅ Accurate calculations

## Future Enhancements

Possible additions:

- Angle measurements at vertices
- Elevation profiles (if DEM available)
- Measure along roads (routing)
- 3D measurements
- Custom unit preferences
