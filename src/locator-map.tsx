// src/LocatorMap.tsx
import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  WMSTileLayer,
  useMap,
  useMapEvents,
  Popup,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet-draw"; // attaches draw controls to L

// Type assertion interfaces for leaflet-draw
interface LeafletDrawOptions {
  position?: string;
  draw?: {
    polygon?: boolean;
    polyline?: boolean;
    rectangle?: boolean;
    marker?: boolean;
    circle?: boolean;
    circlemarker?: boolean;
  };
  edit?: {
    featureGroup: L.FeatureGroup;
    remove?: boolean;
  };
}

interface LeafletDrawControl {
  new (options?: LeafletDrawOptions): L.Control;
}

interface LeafletDrawEvents {
  CREATED: string;
  EDITED: string;
  DELETED: string;
}

interface DrawEvent {
  layer: L.Layer & {
    toGeoJSON(): GeoJSON.Feature;
  };
}

// === YOUR GEOserver WMS base URL (no query params beyond '?') ===
const WMS_URL = "http://35.183.38.140/geoserver/ows?";

// === S3 BUCKET CONFIGURATION (for drawing links) ===
const S3_BASE = "https://ticketviewgis.s3.ca-central-1.amazonaws.com";
const ZIP_SEGMENT = "ZIP 4";
const EXT_ORDER = [".TIF", ".PDF"]; // prefer TIF; can be changed to prefer PDF

// === DRAWING LINK HELPER FUNCTIONS (based on content.ftl logic) ===

// Encode a single path segment (not slashes)
function encodeSegment(s: string): string {
  if (!s) return "";
  return s
    .trim()
    .replace(/%/g, "%25")
    .replace(/&/g, "%26")
    .replace(/\+/g, "%2B")
    .replace(/#/g, "%23")
    .replace(/\s/g, "%20");
}

// Convert path to query param value where / -> %2F
function pathToQueryParam(path: string): string {
  if (!path) return "";
  return path.replace(/\//g, "%2F");
}

// Normalize ID: uppercase, remove extension, replace spaces/underscores with hyphen
function normalizeId(raw: string): string {
  if (!raw) return "";
  const upper = raw.toUpperCase();
  const noext = upper.replace(/\..*$/, "");
  return noext.replace(/[ _]+/g, "-");
}

// Check if ID has hyphen
function hasHyphen(s: string): boolean {
  return s.includes("-");
}

// Determine folder name from normalized ID
function folderFromId(normId: string): string {
  if (!normId) return "";
  if (hasHyphen(normId)) {
    const before = normId.split("-")[0];
    return before || (normId.length >= 6 ? normId.substring(0, 6) : "");
  }
  return normId;
}

// Derive ID from DataSource (e.g., BR2405_03 -> BR2405-003)
function deriveIdFromDataSource(dataSource: string): string {
  if (!dataSource) return "";
  const ds = dataSource.toUpperCase().trim();

  // Base + suffix (1-3 digits)
  const withSuffixMatch = ds.match(/([A-Z]{1,3}\d{3,5})[-_ ]?(\d{1,3})/);
  if (withSuffixMatch) {
    const base = withSuffixMatch[1];
    const suffix = withSuffixMatch[2];
    const suffix3 = suffix.padStart(3, "0");
    return `${base}-${suffix3}`;
  }

  // Base only
  const baseMatch = ds.match(/[A-Z]{1,3}\d{3,5}/);
  if (baseMatch) {
    return baseMatch[0];
  }

  return "";
}

// Zero-pad suffix to 3 digits (used only when derived from DataSource)
function padSuffix3(id: string): string {
  const match = id.match(/^([A-Z]{1,3}\d{3,5})-(\d{1,3})$/);
  if (match) {
    const base = match[1];
    const suffix = match[2].padStart(3, "0");
    return `${base}-${suffix}`;
  }
  return id;
}

// Determine utility folder from RegionalDivision field
function canonicalUtilFromRegionalDivision(rd: string): string {
  const upper = (rd || "").toUpperCase();
  if (
    upper.startsWith("WASTE") ||
    upper.startsWith("SANIT") ||
    upper.startsWith("SEWER")
  ) {
    return "WasteWater";
  }
  if (upper.startsWith("STORM") || upper.startsWith("DRAIN")) {
    return "Storm";
  }
  if (upper.startsWith("WATER")) {
    return "Water";
  }
  return "";
}

// Determine utility folder from layer name
function canonicalUtilFromLayer(layerName: string): string {
  const ln = (layerName || "").toUpperCase();
  if (ln.includes("RWWN")) return "WasteWater";
  if (ln.includes("RSW")) return "Storm";
  if (ln.includes("RWN") || ln.includes("WATER")) return "Water";
  return "Water"; // default
}

// Choose utility folder (prefer feature attribute, fallback to layer name)
function chooseUtilityFolder(layerName: string, properties: any): string {
  const fromFeature = canonicalUtilFromRegionalDivision(
    properties.RegionalDivision || ""
  );
  if (fromFeature) return fromFeature;
  return canonicalUtilFromLayer(layerName);
}

// Get area from Settlement or Municipality
function getArea(properties: any): string {
  const settlement = properties.Settlement || "";
  const municipality = properties.Municipality || "";
  return settlement || municipality || "Region-Wide";
}

// Generate viewer URL for a feature
function generateViewerUrl(layerName: string, properties: any): string {
  // Choose raw ID: AsBuiltNumber > DrawingNumber > derived from DataSource
  const rawA = properties.AsBuiltNumber || "";
  const rawD = properties.DrawingNumber || "";
  let rawS = "";
  if (!rawA && !rawD) {
    rawS = deriveIdFromDataSource(properties.DataSource || "");
  }
  const raw = rawA || rawD || rawS;
  if (!raw) return "";

  // Normalize; only pad when derived from DataSource
  const fromDS = !rawA && !rawD && rawS;
  let norm = normalizeId(raw);
  if (fromDS) {
    norm = padSuffix3(norm);
  }

  const util = chooseUtilityFolder(layerName, properties);
  const area = getArea(properties);
  const idDir = folderFromId(norm);
  const basePath = `${encodeSegment(ZIP_SEGMENT)}/${encodeSegment(
    area
  )}/${util}/${encodeSegment(idDir)}`;

  if (hasHyphen(norm)) {
    // File link (with hyphen, e.g., K602-001)
    const ext = EXT_ORDER[0];
    const fullPath = `${basePath}/${encodeSegment(norm)}${ext}`;
    return `${S3_BASE}/index.html?view=${pathToQueryParam(fullPath)}`;
  } else {
    // Folder link (no hyphen, e.g., K602)
    const fullPrefix = `${basePath}/`;
    return `${S3_BASE}/index.html?prefix=${pathToQueryParam(fullPrefix)}`;
  }
}

// Determine which field was used for the drawing ID
function getDrawingIdInfo(properties: any): { label: string; value: string } {
  const rawA = properties.AsBuiltNumber || "";
  const rawD = properties.DrawingNumber || "";

  if (rawA) {
    return { label: "AsBuiltNumber", value: normalizeId(rawA) };
  }
  if (rawD) {
    return { label: "DrawingNumber", value: normalizeId(rawD) };
  }

  const rawS = deriveIdFromDataSource(properties.DataSource || "");
  if (rawS) {
    return { label: "DataSource", value: padSuffix3(normalizeId(rawS)) };
  }

  return { label: "", value: "" };
}

// === Layer Styling Configuration ===
// Define consistent colors for different infrastructure types
const LAYER_STYLES = {
  // General Infrastructure - neutral colors
  general: { color: "#64748b", opacity: 0.7 }, // slate gray

  // Storm Water - cool gray/blue tones
  storm: { color: "#6b7280", opacity: 0.75 }, // gray for mains/lines
  stormPoint: { color: "#64748b", opacity: 0.8 }, // slightly lighter for points

  // Water Network - blue tones
  water: { color: "#2563eb", opacity: 0.8 }, // bright blue for mains
  waterPoint: { color: "#3b82f6", opacity: 0.85 }, // lighter blue for points

  // Wastewater - brown/amber tones
  wastewater: { color: "#92400e", opacity: 0.75 }, // dark brown for mains
  wastewaterPoint: { color: "#b45309", opacity: 0.8 }, // lighter brown for points
};

// === Configure the layers you want to expose (use exact <Name> from GetCapabilities) ===
const LAYERS = [
  // General Infrastructure
  { key: "waterloo:Roads", title: "Roads", style: "general" },
  { key: "waterloo:Addresses", title: "Addresses", style: "general" },
  { key: "waterloo:Boundary_RMW", title: "RMW Boundary", style: "general" },
  {
    key: "waterloo:CityTownVillage",
    title: "City/Town/Village",
    style: "general",
  },

  // Storm Water System (RSW) - gray tones
  { key: "waterloo:RSW_Mains", title: "Storm Mains", style: "storm" },
  {
    key: "waterloo:RSW_Manholes",
    title: "Storm Manholes",
    style: "stormPoint",
  },
  {
    key: "waterloo:RSW_Catchbasins",
    title: "Storm Catchbasins",
    style: "stormPoint",
  },
  { key: "waterloo:RSW_Ceptors", title: "Storm Ceptors", style: "stormPoint" },
  { key: "waterloo:RSW_Culverts", title: "Storm Culverts", style: "storm" },
  { key: "waterloo:RSW_Ditches", title: "Storm Ditches", style: "storm" },
  { key: "waterloo:RSW_Inlets", title: "Storm Inlets", style: "stormPoint" },
  { key: "waterloo:RSW_Leads", title: "Storm Leads", style: "storm" },
  { key: "waterloo:RSW_Outlets", title: "Storm Outlets", style: "stormPoint" },
  { key: "waterloo:RSW_Ponds", title: "Storm Ponds", style: "stormPoint" },
  { key: "waterloo:RSW_Subdrains", title: "Storm Subdrains", style: "storm" },

  // Water Network (RWN) - blue tones
  { key: "waterloo:Water_Mains", title: "Water Mains", style: "water" },
  { key: "waterloo:RWN_Mains", title: "Water Network Mains", style: "water" },
  { key: "waterloo:RWN_Hydrants", title: "Fire Hydrants", style: "waterPoint" },
  {
    key: "waterloo:RWN_Chambers",
    title: "Water Chambers",
    style: "waterPoint",
  },
  {
    key: "waterloo:RWN_Junctions",
    title: "Water Junctions",
    style: "waterPoint",
  },
  {
    key: "waterloo:RWN_ServiceValves",
    title: "Water Service Valves",
    style: "waterPoint",
  },
  { key: "waterloo:RWN_Services", title: "Water Services", style: "water" },
  { key: "waterloo:RWN_Valves", title: "Water Valves", style: "waterPoint" },
  {
    key: "waterloo:Water_Services",
    title: "Water Services (Alt)",
    style: "water",
  },

  // Wastewater Network (RWWN) - brown tones
  {
    key: "waterloo:RWWN_Mains",
    title: "Wastewater Mains",
    style: "wastewater",
  },
  {
    key: "waterloo:RWWN_LateralLines",
    title: "Wastewater Lateral Lines",
    style: "wastewater",
  },
  {
    key: "waterloo:RWWN_Manholes",
    title: "Wastewater Manholes",
    style: "wastewaterPoint",
  },
] as const;

// Function to fetch available layers from GetCapabilities
async function fetchAvailableLayers(): Promise<string[]> {
  try {
    const capabilitiesUrl = `${WMS_URL}service=WMS&version=1.3.0&request=GetCapabilities`;
    const response = await fetch(capabilitiesUrl);
    const xmlText = await response.text();

    // Parse XML to extract layer names
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Get all Layer elements that have a Name child
    const layerElements = xmlDoc.querySelectorAll("Layer > Name");
    const layerNames: string[] = [];

    layerElements.forEach((nameElement) => {
      const layerName = nameElement.textContent?.trim();
      if (layerName) {
        layerNames.push(layerName);
      }
    });

    return layerNames;
  } catch (error) {
    console.error("Error fetching capabilities:", error);
    return [];
  }
}

// Function to search for addresses using WFS (simplified approach)
async function searchAddresses(searchTerm: string): Promise<SearchResult[]> {
  try {
    const wfsUrl = WMS_URL.replace("ows?", "ows");

    // Get all features first (without CQL filter to avoid field name issues)
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "waterloo:Addresses",
      outputFormat: "application/json",
      maxFeatures: "100", // Get more features to filter client-side
    });

    const response = await fetch(`${wfsUrl}?${params.toString()}`);

    // Check if response is JSON or XML (error)
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("xml")) {
      const errorText = await response.text();
      console.error("WFS Error:", errorText);
      return [];
    }

    const data = await response.json();

    if (data.features && data.features.length > 0) {
      // Log the first feature to see available fields (for debugging)
      console.log("Sample address feature:", data.features[0]);
      console.log(
        "Available fields:",
        Object.keys(data.features[0].properties)
      );

      // Filter results client-side based on the search term
      const searchLower = searchTerm.toLowerCase();
      const filteredFeatures = data.features.filter((feature: any) => {
        const props = feature.properties;

        // Search in all string properties
        return Object.values(props).some(
          (value: any) =>
            value &&
            typeof value === "string" &&
            value.toLowerCase().includes(searchLower)
        );
      });

      return filteredFeatures.slice(0, 20).map((feature: any) => {
        const props = feature.properties;
        const coords = feature.geometry.coordinates;

        // Build address string from all available string fields
        const addressParts: string[] = [];

        // Add all non-null string values to create an address
        Object.entries(props).forEach(([key, value]: [string, any]) => {
          if (value && typeof value === "string" && value.trim()) {
            // Skip obviously non-address fields
            if (
              !key.toLowerCase().includes("id") &&
              !key.toLowerCase().includes("objectid") &&
              !key.toLowerCase().includes("fid")
            ) {
              addressParts.push(value.trim());
            }
          }
        });

        return {
          id: feature.id || `addr_${Math.random()}`,
          address: addressParts.join(" ") || "Address",
          coordinates: [coords[1], coords[0]] as [number, number], // Lat, Lng
          properties: props,
        };
      });
    }

    return [];
  } catch (error) {
    console.error("Error searching addresses:", error);
    return [];
  }
}

// Function to search nearby infrastructure features
async function searchNearbyFeatures(
  coordinates: [number, number],
  radiusMeters: number = 100,
  layerKeys: string[]
): Promise<any[]> {
  try {
    const [lat, lng] = coordinates;
    const bbox = calculateBoundingBox(lat, lng, radiusMeters);

    const results = await Promise.all(
      layerKeys.map(async (layerKey) => {
        try {
          const wfsUrl = WMS_URL.replace("ows?", "ows");
          const params = new URLSearchParams({
            service: "WFS",
            version: "2.0.0",
            request: "GetFeature",
            typeName: layerKey,
            outputFormat: "application/json",
            maxFeatures: "50",
            bbox: `${bbox.getWest()},${bbox.getSouth()},${bbox.getEast()},${bbox.getNorth()},EPSG:4326`,
          });

          const response = await fetch(`${wfsUrl}?${params.toString()}`);
          const data = await response.json();

          return {
            layerKey,
            features: data.features || [],
          };
        } catch (error) {
          console.error(`Error fetching features for ${layerKey}:`, error);
          return { layerKey, features: [] };
        }
      })
    );

    return results.filter((result) => result.features.length > 0);
  } catch (error) {
    console.error("Error searching nearby features:", error);
    return [];
  }
}

type LayerKey = (typeof LAYERS)[number]["key"];

// Type for popup state
interface PopupState {
  latlng: L.LatLng;
  content: string;
}

// Type for URL parameters
interface UrlParams {
  lat?: number;
  lng?: number;
  radius?: number; // in meters, default 1000m
}

// Type for search results
interface SearchResult {
  id: string;
  address: string;
  coordinates: [number, number];
  properties: Record<string, any>;
}

// Parse URL parameters
function getUrlParams(): UrlParams {
  const urlParams = new URLSearchParams(window.location.search);
  const lat = urlParams.get("lat");
  const lng = urlParams.get("lng");
  const radius = urlParams.get("radius");

  return {
    lat: lat ? parseFloat(lat) : undefined,
    lng: lng ? parseFloat(lng) : undefined,
    radius: radius ? parseFloat(radius) : 1000, // default 1km radius
  };
}

// Calculate bounding box around a point
function calculateBoundingBox(
  lat: number,
  lng: number,
  radiusMeters: number
): L.LatLngBounds {
  // Approximate degrees per meter (rough calculation)
  const latDegreePerMeter = 1 / 111320;
  const lngDegreePerMeter = 1 / (111320 * Math.cos((lat * Math.PI) / 180));

  const latOffset = radiusMeters * latDegreePerMeter;
  const lngOffset = radiusMeters * lngDegreePerMeter;

  const southwest = L.latLng(lat - latOffset, lng - lngOffset);
  const northeast = L.latLng(lat + latOffset, lng + lngOffset);

  return L.latLngBounds(southwest, northeast);
}

// --- Drawing controls hooked to the raw Leaflet map instance ---
function DrawControl() {
  const map = useMap();

  useEffect(() => {
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const DrawControl = (L.Control as unknown as { Draw: LeafletDrawControl })
      .Draw;
    const drawControl = new DrawControl({
      position: "topleft",
      draw: {
        polygon: true,
        polyline: true,
        rectangle: true,
        marker: true,
        circle: false,
        circlemarker: false,
      },
      edit: { featureGroup: drawnItems, remove: true },
    });

    map.addControl(drawControl);

    const drawEvents = (L as unknown as { Draw: { Event: LeafletDrawEvents } })
      .Draw.Event;

    // Load saved drawings from localStorage on mount
    try {
      const saved = localStorage.getItem("wms-drawings");
      if (saved) {
        const geojson = JSON.parse(saved);
        L.geoJSON(geojson, {
          onEachFeature: (_feature, layer) => {
            drawnItems.addLayer(layer);
          },
        });
      }
    } catch (error) {
      console.error("Error loading saved drawings:", error);
    }

    function saveDrawings() {
      const geojson = drawnItems.toGeoJSON();
      localStorage.setItem("wms-drawings", JSON.stringify(geojson));
      console.log("Drawings saved to localStorage");
    }

    function onCreated(e: DrawEvent) {
      drawnItems.addLayer(e.layer);
      const gj = e.layer.toGeoJSON();
      console.log("DRAWN GEOJSON:", gj);
      saveDrawings(); // Auto-save on create
    }
    function onEdited(e: unknown) {
      console.log("EDITED:", e);
      saveDrawings(); // Auto-save on edit
    }
    function onDeleted(e: unknown) {
      console.log("DELETED:", e);
      saveDrawings(); // Auto-save on delete
    }

    map.on(drawEvents.CREATED, onCreated);
    map.on(drawEvents.EDITED, onEdited);
    map.on(drawEvents.DELETED, onDeleted);

    // Create export/clear controls
    const exportControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        const container = L.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control"
        );
        container.style.background = "white";
        container.style.padding = "4px";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.gap = "4px";

        // Export button
        const exportBtn = L.DomUtil.create("button", "", container);
        exportBtn.innerHTML = "💾 Export";
        exportBtn.title = "Export drawings as GeoJSON";
        exportBtn.style.padding = "4px 8px";
        exportBtn.style.fontSize = "12px";
        exportBtn.style.cursor = "pointer";
        exportBtn.style.border = "none";
        exportBtn.style.background = "#007cba";
        exportBtn.style.color = "white";
        exportBtn.style.borderRadius = "4px";
        exportBtn.style.fontWeight = "600";

        L.DomEvent.on(exportBtn, "click", function (e) {
          L.DomEvent.stopPropagation(e);
          const geojson = drawnItems.toGeoJSON();
          const blob = new Blob([JSON.stringify(geojson, null, 2)], {
            type: "application/json",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `wms-drawings-${
            new Date().toISOString().split("T")[0]
          }.geojson`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });

        // Clear button
        const clearBtn = L.DomUtil.create("button", "", container);
        clearBtn.innerHTML = "🗑️ Clear";
        clearBtn.title = "Clear all drawings";
        clearBtn.style.padding = "4px 8px";
        clearBtn.style.fontSize = "12px";
        clearBtn.style.cursor = "pointer";
        clearBtn.style.border = "none";
        clearBtn.style.background = "#ef4444";
        clearBtn.style.color = "white";
        clearBtn.style.borderRadius = "4px";
        clearBtn.style.fontWeight = "600";

        L.DomEvent.on(clearBtn, "click", function (e) {
          L.DomEvent.stopPropagation(e);
          if (
            confirm(
              "Are you sure you want to clear all drawings? This will also remove saved drawings."
            )
          ) {
            drawnItems.clearLayers();
            localStorage.removeItem("wms-drawings");
            console.log("All drawings cleared");
          }
        });

        return container;
      },
    });

    const exportCtrl = new exportControl();
    map.addControl(exportCtrl);

    return () => {
      map.off(drawEvents.CREATED, onCreated);
      map.off(drawEvents.EDITED, onEdited);
      map.off(drawEvents.DELETED, onDeleted);
      map.removeControl(drawControl);
      map.removeControl(exportCtrl);
      map.removeLayer(drawnItems);
    };
  }, [map]);

  return null;
}

// Build a WMS 1.3.0 GetFeatureInfo URL for all currently visible layers
function buildGetFeatureInfoUrl(
  map: L.Map,
  latlng: L.LatLng,
  visibleLayerKeys: string[],
  spatialFilter?: L.LatLngBounds
): string | null {
  if (!visibleLayerKeys.length) return null;

  const point = map.latLngToContainerPoint(latlng);
  const size = map.getSize();

  // Use spatial filter bounds if provided, otherwise use current map bounds
  const bounds = spatialFilter || map.getBounds();

  // Use EPSG:3857 to avoid axis-order confusion; project bounds to meters.
  const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
  const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
  const bbox = [sw.x, sw.y, ne.x, ne.y].join(",");

  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetFeatureInfo",
    layers: visibleLayerKeys.join(","), // which layers are drawn
    query_layers: visibleLayerKeys.join(","), // which layers to query
    info_format: "application/json", // try JSON first
    crs: "EPSG:3857",
    bbox,
    width: String(size.x),
    height: String(size.y),
    i: String(Math.round(point.x)), // WMS 1.3.0 uses i/j
    j: String(Math.round(point.y)),
    feature_count: "50", // Increased from 10 since we're filtering spatially
  });

  return `${WMS_URL}${WMS_URL.endsWith("?") ? "" : "?"}${params.toString()}`;
}

// Handle map clicks: send GetFeatureInfo and show results in a popup
function MapClickInfo({
  visibleLayerKeys,
  setPopup,
  spatialFilter,
}: {
  visibleLayerKeys: string[];
  setPopup: (popup: PopupState | null) => void;
  spatialFilter?: L.LatLngBounds;
}) {
  const map = useMap();

  useMapEvents({
    async click(e) {
      const url = buildGetFeatureInfoUrl(
        map,
        e.latlng,
        visibleLayerKeys,
        spatialFilter
      );
      if (!url) {
        setPopup({ latlng: e.latlng, content: "No layers selected." });
        return;
      }

      try {
        console.log(
          `%c🔍 GETFEATUREINFO REQUEST`,
          "color: #8b5cf6; font-weight: bold; font-size: 12px"
        );
        console.log(`   └─ Layers queried: ${visibleLayerKeys.join(", ")}`);
        console.log(
          `   └─ Click location: ${e.latlng.lat.toFixed(
            6
          )}, ${e.latlng.lng.toFixed(6)}`
        );

        const resp = await fetch(url);
        const ct = resp.headers.get("content-type") || "";
        let html = "";

        if (ct.includes("application/json")) {
          const json = await resp.json();
          const features = json.features || [];

          console.log(
            `%c📍 FEATURES FOUND: ${features.length}`,
            features.length > 0
              ? "color: #10b981; font-weight: bold"
              : "color: #94a3b8; font-weight: bold"
          );

          if (features.length > 0) {
            features.forEach((f: any, idx: number) => {
              const layerName = f.id
                ? f.id.split(".")[0]
                : `Feature ${idx + 1}`;
              console.log(`   ${idx + 1}. ${layerName}`);
              console.log(`      └─ Properties:`, f.properties);
            });
          } else {
            console.log(`   └─ No features at this location`);
          }
          if (features.length === 0) {
            html = "<b>No features at this point.</b>";
          } else {
            // Show all features found, with drawing links
            html =
              "<div style='max-height: 600px; overflow-y: auto;'><b>Feature Info</b>";
            features.forEach((f: any, index: number) => {
              const props = f.properties || {};
              const layerName = f.id
                ? f.id.split(".")[0]
                : `Feature ${index + 1}`;

              // Try to generate drawing link
              const viewerUrl = generateViewerUrl(layerName, props);
              const drawingInfo = getDrawingIdInfo(props);

              html += `<div style="margin-top:${
                index > 0 ? "12px" : "6px"
              }; padding: 8px; background: #f9f9f9; border-radius: 4px; border-left: 3px solid #007cba;">`;
              html += `<strong style="color: #007cba;">${layerName}</strong>`;

              // Show drawing ID and link if available
              if (drawingInfo.value && viewerUrl) {
                html += `<div style="margin: 6px 0; padding: 6px; background: #fff3cd; border-radius: 4px; border: 1px solid #ffc107;">`;
                html += `<div style="font-size: 11px; color: #856404;"><strong>📄 ${drawingInfo.label}:</strong> ${drawingInfo.value}</div>`;
                html += `<a href="${viewerUrl}" target="_blank" rel="noopener" style="
                  display: inline-block;
                  margin-top: 4px;
                  padding: 4px 10px;
                  background: #007cba;
                  color: white;
                  text-decoration: none;
                  border-radius: 4px;
                  font-size: 12px;
                  font-weight: 600;
                ">🔗 View Drawing</a>`;
                html += `</div>`;
              }

              html += `<table style="margin-top:6px; width: 100%; font-size: 12px;">`;
              html += Object.entries(props)
                .map(
                  ([k, v]) =>
                    `<tr><td style="padding: 2px 8px 2px 0; font-weight: 600; color: #555;">${k}</td><td style="padding: 2px 0;">${String(
                      v
                    )}</td></tr>`
                )
                .join("");
              html += "</table></div>";
            });
            html += "</div>";
          }
        } else {
          // Fallback: many GeoServer setups return HTML/text
          const text = await resp.text();
          html = text || "<b>No info returned.</b>";
        }

        setPopup({ latlng: e.latlng, content: html });
      } catch (err) {
        console.error(err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        setPopup({
          latlng: e.latlng,
          content: `<b>Error</b><div>${errorMessage}</div>`,
        });
      }
    },
  });

  return null;
}

// Component to handle URL-based center and spatial filtering
function UrlBasedMapController({
  urlParams,
  spatialFilter,
}: {
  urlParams: UrlParams;
  spatialFilter?: L.LatLngBounds;
}) {
  const map = useMap();

  useEffect(() => {
    if (urlParams.lat && urlParams.lng) {
      // Center map on URL coordinates
      map.setView([urlParams.lat, urlParams.lng], 15);

      // Add a marker for the target location
      const marker = L.marker([urlParams.lat, urlParams.lng])
        .addTo(map)
        .bindPopup(
          `Target Location<br/>Lat: ${urlParams.lat}<br/>Lng: ${urlParams.lng}`
        );

      // Show the spatial filter area if provided
      if (spatialFilter) {
        const rectangle = L.rectangle(spatialFilter, {
          color: "#ff7800",
          weight: 2,
          fillOpacity: 0.1,
        }).addTo(map);

        rectangle.bindPopup(`Search Area<br/>Radius: ${urlParams.radius}m`);
      }

      return () => {
        map.removeLayer(marker);
        if (spatialFilter) {
          map.eachLayer((layer) => {
            if (layer instanceof L.Rectangle) {
              map.removeLayer(layer);
            }
          });
        }
      };
    }
  }, [map, urlParams, spatialFilter]);

  return null;
}

// Component to handle search result highlighting
function SearchResultController({
  selectedResult,
  nearbyFeatures,
}: {
  selectedResult: SearchResult | null;
  nearbyFeatures: any[];
}) {
  const map = useMap();

  useEffect(() => {
    if (selectedResult) {
      // Zoom to the selected location
      map.setView(selectedResult.coordinates, 18);

      // Create a highlight marker with custom styling
      const highlightIcon = L.divIcon({
        className: "search-highlight-marker",
        html: `
          <div style="
            background: #ff4444; 
            border: 3px solid white; 
            border-radius: 50%; 
            width: 20px; 
            height: 20px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            animation: pulse 2s infinite;
          "></div>
          <style>
            @keyframes pulse {
              0% { transform: scale(1); opacity: 1; }
              50% { transform: scale(1.2); opacity: 0.7; }
              100% { transform: scale(1); opacity: 1; }
            }
          </style>
        `,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });

      const marker = L.marker(selectedResult.coordinates, {
        icon: highlightIcon,
      })
        .addTo(map)
        .bindPopup(
          `
          <div>
            <strong>📍 ${selectedResult.address}</strong>
            <br/>
            <small>Lat: ${selectedResult.coordinates[0].toFixed(6)}</small>
            <br/>
            <small>Lng: ${selectedResult.coordinates[1].toFixed(6)}</small>
          </div>
        `
        )
        .openPopup();

      // Add a search radius circle
      const circle = L.circle(selectedResult.coordinates, {
        radius: 50, // 50 meters
        color: "#ff4444",
        fillColor: "#ff4444",
        fillOpacity: 0.1,
        weight: 2,
        dashArray: "5, 5",
      }).addTo(map);

      return () => {
        map.removeLayer(marker);
        map.removeLayer(circle);
      };
    }
  }, [map, selectedResult, nearbyFeatures]);

  return null;
}

export default function LocatorMap() {
  const [visible, setVisible] = useState(
    () => new Set<LayerKey>([LAYERS[0].key])
  ); // default: first layer on
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [availableLayers, setAvailableLayers] = useState<string[]>([]);
  const [showAvailableLayers, setShowAvailableLayers] = useState(false);

  // Search functionality state
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(
    null
  );
  const [nearbyFeatures, setNearbyFeatures] = useState<any[]>([]);

  const urlParams = useMemo(() => getUrlParams(), []);
  const spatialFilter = useMemo(() => {
    if (urlParams.lat && urlParams.lng && urlParams.radius) {
      return calculateBoundingBox(
        urlParams.lat,
        urlParams.lng,
        urlParams.radius
      );
    }
    return undefined;
  }, [urlParams]);

  const visibleLayerKeys = useMemo(() => Array.from(visible), [visible]);

  // Default center - use URL params if available, otherwise Waterloo, Ontario
  const defaultCenter: [number, number] =
    urlParams.lat && urlParams.lng
      ? [urlParams.lat, urlParams.lng]
      : [43.4643, -80.5204]; // Waterloo, Ontario coordinates

  const defaultZoom = urlParams.lat && urlParams.lng ? 15 : 13;

  function toggleLayer(key: LayerKey) {
    setVisible((prev) => {
      const next = new Set(prev);

      if (next.has(key)) {
        next.delete(key);
        console.log(
          `%c⬜ LAYER DISABLED: ${key}`,
          "color: #94a3b8; font-weight: bold"
        );
      } else {
        next.add(key);
        console.log(
          `%c✅ LAYER ENABLED: ${key}`,
          "color: #10b981; font-weight: bold; font-size: 13px"
        );
        console.log(`   └─ Watch for loading messages above...`);
      }

      return next;
    });
  }

  // Fix default marker icon paths when bundling
  useEffect(() => {
    // @ts-expect-error - This is a known workaround for Leaflet + bundlers
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl:
        "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
      iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
      shadowUrl:
        "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    });
  }, []);

  // Fetch available layers on component mount
  useEffect(() => {
    console.log(
      `%c🗺️ WMS MAP VIEWER INITIALIZED`,
      "color: #0f172a; font-weight: bold; font-size: 14px; background: #fbbf24; padding: 4px 8px; border-radius: 4px"
    );
    console.log(
      `%c📊 Total available layers: ${LAYERS.length}`,
      "color: #1e40af; font-weight: bold"
    );
    console.log(
      `%c🟢 Initially active layers: ${visibleLayerKeys.length}`,
      "color: #16a34a; font-weight: bold"
    );
    visibleLayerKeys.forEach((key) => {
      const layer = LAYERS.find((l) => l.key === key);
      console.log(`   └─ ${layer?.title || key}`);
    });
    console.log(
      `%c💡 TIP: Check/uncheck layers in the sidebar to see loading logs`,
      "color: #6b7280; font-style: italic"
    );
    console.log(
      `%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      "color: #e5e7eb"
    );

    fetchAvailableLayers().then(setAvailableLayers);
  }, []);

  // Search functionality
  const handleSearch = async () => {
    if (!searchTerm.trim()) return;

    setIsSearching(true);
    try {
      const results = await searchAddresses(searchTerm);
      setSearchResults(results);
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setIsSearching(false);
    }
  };

  // Handle search result selection
  const handleResultSelect = async (result: SearchResult) => {
    setSelectedResult(result);
    setSearchResults([]); // Hide search results

    // Search for nearby features
    const nearby = await searchNearbyFeatures(
      result.coordinates,
      50, // 50 meter radius
      visibleLayerKeys
    );
    setNearbyFeatures(nearby);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "340px 1fr",
        height: "100vh",
        background: "#f8fafc",
      }}
    >
      {/* Sidebar: layer toggles */}
      <div
        style={{
          padding: 16,
          borderRight: "1px solid #e5e7eb",
          overflow: "auto",
          background: "white",
        }}
      >
        <h3 style={{ margin: "0 0 16px", color: "#0f172a" }}>
          🗺️ WMS Map Viewer
        </h3>

        {/* Search Section */}
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            background: "#f8fafc",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
          }}
        >
          <h4 style={{ margin: "0 0 10px", fontSize: 14, color: "#1e293b" }}>
            🔍 Search Address
          </h4>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="Search addresses..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSearch()}
              style={{
                flex: 1,
                padding: "8px 10px",
                fontSize: 13,
                border: "1px solid #d1d5db",
                borderRadius: 8,
                outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => (e.target.style.borderColor = "#007cba")}
              onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
            />
            <button
              onClick={handleSearch}
              disabled={!searchTerm.trim() || isSearching}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                backgroundColor: "#007cba",
                color: "white",
                border: "none",
                borderRadius: 8,
                cursor:
                  !searchTerm.trim() || isSearching ? "not-allowed" : "pointer",
                opacity: !searchTerm.trim() || isSearching ? 0.6 : 1,
                fontWeight: 600,
              }}
            >
              {isSearching ? "..." : "Search"}
            </button>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div
              style={{
                marginTop: 10,
                maxHeight: 140,
                overflow: "auto",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                backgroundColor: "white",
              }}
            >
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  onClick={() => handleResultSelect(result)}
                  style={{
                    padding: "8px 10px",
                    fontSize: 12,
                    borderBottom: "1px solid #f3f4f6",
                    cursor: "pointer",
                    backgroundColor: "white",
                    transition: "background-color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f3f4f6";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "white";
                  }}
                >
                  📍 {result.address}
                </div>
              ))}
            </div>
          )}

          {/* Selected Result Info */}
          {selectedResult && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                backgroundColor: "#fef3c7",
                borderRadius: 8,
                fontSize: 12,
                border: "1px solid #fbbf24",
              }}
            >
              <strong style={{ color: "#92400e" }}>📍 Selected:</strong>{" "}
              <span style={{ color: "#78350f" }}>{selectedResult.address}</span>
              <br />
              <button
                onClick={() => {
                  setSelectedResult(null);
                  setNearbyFeatures([]);
                }}
                style={{
                  marginTop: 6,
                  padding: "4px 8px",
                  fontSize: 11,
                  backgroundColor: "#f59e0b",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Clear
              </button>
            </div>
          )}

          {/* Nearby Features */}
          {nearbyFeatures.length > 0 && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                backgroundColor: "#d1fae5",
                borderRadius: 8,
                fontSize: 12,
                maxHeight: 120,
                overflow: "auto",
                border: "1px solid #6ee7b7",
              }}
            >
              <strong style={{ color: "#065f46" }}>
                🏗️ Nearby Infrastructure:
              </strong>
              {nearbyFeatures.map((layer) => (
                <div
                  key={layer.layerKey}
                  style={{ marginTop: 6, color: "#047857" }}
                >
                  <strong>{layer.layerKey.split(":")[1]}:</strong>{" "}
                  {layer.features.length} features
                </div>
              ))}
            </div>
          )}
        </div>

        {/* URL Parameters Info */}
        {urlParams.lat && urlParams.lng && (
          <div
            style={{
              marginBottom: 16,
              padding: 12,
              backgroundColor: "#dbeafe",
              borderRadius: 8,
              fontSize: 12,
              border: "1px solid #93c5fd",
            }}
          >
            <strong style={{ color: "#1e40af" }}>🎯 Target Location:</strong>
            <div style={{ marginTop: 4, color: "#1e3a8a" }}>
              <div>Lat: {urlParams.lat.toFixed(6)}</div>
              <div>Lng: {urlParams.lng.toFixed(6)}</div>
              <div>Radius: {urlParams.radius}m</div>
            </div>
          </div>
        )}

        <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#1e293b" }}>
          📚 Layers
        </h4>

        {/* Button to show/hide available layers */}
        <button
          onClick={() => setShowAvailableLayers(!showAvailableLayers)}
          style={{
            marginBottom: 12,
            padding: "6px 10px",
            fontSize: 12,
            backgroundColor: "#f9fafb",
            border: "1px solid #d1d5db",
            borderRadius: 8,
            cursor: "pointer",
            width: "100%",
            textAlign: "left",
            fontWeight: 500,
            color: "#374151",
          }}
        >
          {showAvailableLayers ? "▼" : "▶"}{" "}
          {showAvailableLayers ? "Hide" : "Show"} Available Layers (
          {availableLayers.length})
        </button>

        {/* Show available layers from GetCapabilities */}
        {showAvailableLayers && (
          <div
            style={{
              marginBottom: 16,
              padding: 10,
              backgroundColor: "#f9fafb",
              borderRadius: 8,
              fontSize: 11,
              maxHeight: 200,
              overflow: "auto",
              border: "1px solid #e5e7eb",
            }}
          >
            <strong style={{ color: "#374151" }}>
              Available layers from GetCapabilities:
            </strong>
            {availableLayers.length > 0 ? (
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {availableLayers.map((layer) => (
                  <li key={layer} style={{ marginBottom: 3, color: "#6b7280" }}>
                    <code style={{ fontSize: 10, color: "#1f2937" }}>
                      {layer}
                    </code>
                  </li>
                ))}
              </ul>
            ) : (
              <p
                style={{
                  margin: "6px 0 0",
                  fontStyle: "italic",
                  color: "#9ca3af",
                }}
              >
                Loading...
              </p>
            )}
          </div>
        )}

        {/* Render layers grouped by category */}
        {[
          {
            title: "🏢 General Infrastructure",
            layers: LAYERS.filter(
              (l) =>
                l.key.includes("Roads") ||
                l.key.includes("Addresses") ||
                l.key.includes("Boundary") ||
                l.key.includes("City")
            ),
          },
          {
            title: "🌧️ Storm Water (RSW)",
            layers: LAYERS.filter((l) => l.key.includes("RSW_")),
          },
          {
            title: "💧 Water Network (RWN)",
            layers: LAYERS.filter(
              (l) => l.key.includes("RWN_") || l.key.includes("Water_")
            ),
          },
          {
            title: "🚰 Wastewater (RWWN)",
            layers: LAYERS.filter((l) => l.key.includes("RWWN_")),
          },
        ].map((group) => (
          <div key={group.title} style={{ marginBottom: 16 }}>
            <h5
              style={{
                margin: "0 0 8px",
                fontSize: 12,
                fontWeight: 600,
                color: "#334155",
                borderBottom: "2px solid #e5e7eb",
                paddingBottom: 6,
              }}
            >
              {group.title}
            </h5>
            {group.layers.map((l) => {
              const styleConfig =
                LAYER_STYLES[l.style as keyof typeof LAYER_STYLES] ||
                LAYER_STYLES.general;

              return (
                <label
                  key={l.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                    marginLeft: 4,
                    backgroundColor: visible.has(l.key)
                      ? "#dcfce7"
                      : "transparent",
                    padding: "6px 8px",
                    borderRadius: "6px",
                    fontSize: 12,
                    border: visible.has(l.key)
                      ? "1px solid #86efac"
                      : "1px solid transparent",
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (!visible.has(l.key)) {
                      e.currentTarget.style.backgroundColor = "#f8fafc";
                      e.currentTarget.style.borderColor = "#cbd5e1";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!visible.has(l.key)) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.borderColor = "transparent";
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    checked={visible.has(l.key)}
                    onChange={() => toggleLayer(l.key)}
                    style={{ width: 16, height: 16 }}
                  />
                  {/* Color indicator */}
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      backgroundColor: styleConfig.color,
                      border: "1px solid rgba(0,0,0,0.2)",
                      flexShrink: 0,
                    }}
                    title={`Color: ${styleConfig.color}, Opacity: ${styleConfig.opacity}`}
                  />
                  <span style={{ flex: 1, color: "#1f2937" }}>{l.title}</span>
                  {visible.has(l.key) && (
                    <span style={{ fontSize: 14, color: "#16a34a" }}>✓</span>
                  )}
                </label>
              );
            })}
          </div>
        ))}

        {/* Color Legend */}
        <div
          style={{
            marginTop: 16,
            padding: 10,
            backgroundColor: "#fefce8",
            borderRadius: 8,
            fontSize: 11,
            border: "1px solid #fde047",
          }}
        >
          <strong style={{ color: "#713f12" }}>🎨 Color Legend</strong>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: LAYER_STYLES.water.color,
                  border: "1px solid rgba(0,0,0,0.2)",
                }}
              />
              <span style={{ color: "#78350f" }}>Water Network (blue)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: LAYER_STYLES.storm.color,
                  border: "1px solid rgba(0,0,0,0.2)",
                }}
              />
              <span style={{ color: "#78350f" }}>Storm Water (gray)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: LAYER_STYLES.wastewater.color,
                  border: "1px solid rgba(0,0,0,0.2)",
                }}
              />
              <span style={{ color: "#78350f" }}>Wastewater (brown)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: LAYER_STYLES.general.color,
                  border: "1px solid rgba(0,0,0,0.2)",
                }}
              />
              <span style={{ color: "#78350f" }}>General Infrastructure</span>
            </div>
          </div>
        </div>

        {/* Debug info */}
        <div
          style={{
            marginTop: 16,
            padding: 10,
            backgroundColor: "#f9fafb",
            borderRadius: 8,
            fontSize: 11,
            border: "1px solid #e5e7eb",
            color: "#6b7280",
          }}
        >
          <strong style={{ color: "#374151" }}>🔧 Debug Info</strong>
          <div style={{ marginTop: 4 }}>
            Active layers: <strong>{visibleLayerKeys.length}</strong>
          </div>
          <div style={{ fontSize: 10, marginTop: 2 }}>
            Check browser console for loading errors
          </div>
        </div>

        <div
          style={{
            marginTop: 16,
            padding: 10,
            backgroundColor: "#eff6ff",
            borderRadius: 8,
            fontSize: 12,
            border: "1px solid #bfdbfe",
            color: "#1e40af",
          }}
        >
          <strong style={{ color: "#1e3a8a" }}>💡 Usage:</strong>
          <div style={{ marginTop: 6, lineHeight: "1.6" }}>
            • Click map for feature info
            <br />• Add ?lat=43.7&lng=-79.4&radius=500 to URL for spatial
            filtering
          </div>
          {spatialFilter && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                backgroundColor: "#fed7aa",
                borderRadius: 6,
                border: "1px solid #fb923c",
                color: "#7c2d12",
              }}
            >
              🎯 <strong>Spatial filtering active!</strong>
              <br />
              Only showing data within {urlParams.radius}m of target.
            </div>
          )}
        </div>
      </div>

      {/* Map container */}
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        style={{ height: "100%", width: "100%" }}
      >
        {/* Basemap */}
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* WMS overlays for each visible layer with spatial filtering */}
        {LAYERS.map((l, idx) => {
          if (!visible.has(l.key)) return null;

          // Get style configuration for this layer
          const styleConfig =
            LAYER_STYLES[l.style as keyof typeof LAYER_STYLES] ||
            LAYER_STYLES.general;

          return (
            <WMSTileLayer
              key={l.key}
              url={WMS_URL}
              layers={l.key}
              format="image/png"
              transparent={true}
              version="1.3.0"
              // @ts-expect-error - tiled is not in the type definition but is valid
              tiled={true}
              styles=""
              zIndex={200 + idx} // keep overlays above base
              opacity={styleConfig.opacity}
              // Add spatial filtering if bounds are provided
              {...(spatialFilter && {
                // Add CQL_FILTER for spatial filtering (if your GeoServer supports it)
                cql_filter: spatialFilter
                  ? `BBOX(the_geom,${spatialFilter.getWest()},${spatialFilter.getSouth()},${spatialFilter.getEast()},${spatialFilter.getNorth()},'EPSG:4326')`
                  : undefined,
              })}
              eventHandlers={{
                loading: () => {
                  console.log(
                    `%c🔄 LOADING: ${l.title} (${l.key})`,
                    "color: #f59e0b; font-weight: bold"
                  );
                },
                load: (e) => {
                  console.log(
                    `%c✅ SUCCESS: ${l.title} (${l.key})`,
                    "color: #10b981; font-weight: bold"
                  );
                  console.log(`   └─ Tile URL: ${e.target._url}`);
                  console.log(
                    `   └─ Opacity: ${styleConfig.opacity}, Color: ${styleConfig.color}`
                  );
                },
                tileerror: (e) => {
                  console.error(
                    `%c❌ ERROR: ${l.title} (${l.key})`,
                    "color: #ef4444; font-weight: bold"
                  );
                  console.error(`   └─ Tile coords:`, e.coords);
                  console.error(`   └─ Error:`, e.error);
                  console.error(`   └─ Tile URL:`, e.tile?.src);
                },
                tileload: (e) => {
                  console.log(
                    `%c📦 TILE LOADED: ${l.title}`,
                    "color: #3b82f6; font-size: 11px"
                  );
                  console.log(
                    `   └─ Coords: z=${e.coords.z}, x=${e.coords.x}, y=${e.coords.y}`
                  );
                  console.log(
                    `   └─ URL: ${e.tile?.src?.substring(0, 100)}...`
                  );
                },
              }}
            />
          );
        })}

        {/* URL-based map controller */}
        <UrlBasedMapController
          urlParams={urlParams}
          spatialFilter={spatialFilter}
        />

        {/* Search result controller */}
        <SearchResultController
          selectedResult={selectedResult}
          nearbyFeatures={nearbyFeatures}
        />

        {/* Drawing tools */}
        <DrawControl />

        {/* Click → GetFeatureInfo with spatial filtering */}
        <MapClickInfo
          visibleLayerKeys={visibleLayerKeys}
          setPopup={setPopup}
          spatialFilter={spatialFilter}
        />

        {/* Info popup */}
        {popup && (
          <Popup
            position={popup.latlng}
            eventHandlers={{
              remove: () => setPopup(null),
            }}
          >
            <div dangerouslySetInnerHTML={{ __html: popup.content }} />
          </Popup>
        )}
      </MapContainer>
    </div>
  );
}
