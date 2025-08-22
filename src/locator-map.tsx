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

// === Configure the layers you want to expose (use exact <Name> from GetCapabilities) ===
const LAYERS = [
  // General Infrastructure
  { key: "waterloo:Roads", title: "Roads" },
  { key: "waterloo:Addresses", title: "Addresses" },
  { key: "waterloo:Boundary_RMW", title: "RMW Boundary" },
  { key: "waterloo:CityTownVillage", title: "City/Town/Village" },

  // Storm Water System (RSW)
  { key: "waterloo:RSW_Mains", title: "Storm Mains" },
  { key: "waterloo:RSW_Manholes", title: "Storm Manholes" },
  { key: "waterloo:RSW_Catchbasins", title: "Storm Catchbasins" },
  { key: "waterloo:RSW_Ceptors", title: "Storm Ceptors" },
  { key: "waterloo:RSW_Culverts", title: "Storm Culverts" },
  { key: "waterloo:RSW_Ditches", title: "Storm Ditches" },
  { key: "waterloo:RSW_Inlets", title: "Storm Inlets" },
  { key: "waterloo:RSW_Leads", title: "Storm Leads" },
  { key: "waterloo:RSW_Outlets", title: "Storm Outlets" },
  { key: "waterloo:RSW_Ponds", title: "Storm Ponds" },
  { key: "waterloo:RSW_Subdrains", title: "Storm Subdrains" },

  // Water Network (RWN)
  { key: "waterloo:Water_Mains", title: "Water Mains" },
  { key: "waterloo:RWN_Mains", title: "Water Network Mains" },
  { key: "waterloo:RWN_Hydrants", title: "Fire Hydrants" },
  { key: "waterloo:RWN_Chambers", title: "Water Chambers" },
  { key: "waterloo:RWN_Junctions", title: "Water Junctions" },
  { key: "waterloo:RWN_ServiceValves", title: "Water Service Valves" },
  { key: "waterloo:RWN_Services", title: "Water Services" },
  { key: "waterloo:RWN_Valves", title: "Water Valves" },
  { key: "waterloo:Water_Services", title: "Water Services (Alt)" },

  // Wastewater Network (RWWN)
  { key: "waterloo:RWWN_Mains", title: "Wastewater Mains" },
  { key: "waterloo:RWWN_LateralLines", title: "Wastewater Lateral Lines" },
  { key: "waterloo:RWWN_Manholes", title: "Wastewater Manholes" },
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

    function onCreated(e: DrawEvent) {
      drawnItems.addLayer(e.layer);
      const gj = e.layer.toGeoJSON();
      console.log("DRAWN GEOJSON:", gj);
      // TODO: send gj to your API for storage/spatial checks if needed
    }
    function onEdited(e: unknown) {
      console.log("EDITED:", e);
    }
    function onDeleted(e: unknown) {
      console.log("DELETED:", e);
    }

    map.on(drawEvents.CREATED, onCreated);
    map.on(drawEvents.EDITED, onEdited);
    map.on(drawEvents.DELETED, onDeleted);

    return () => {
      map.off(drawEvents.CREATED, onCreated);
      map.off(drawEvents.EDITED, onEdited);
      map.off(drawEvents.DELETED, onDeleted);
      map.removeControl(drawControl);
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
        const resp = await fetch(url);
        const ct = resp.headers.get("content-type") || "";
        let html = "";

        if (ct.includes("application/json")) {
          const json = await resp.json();
          console.log(json);
          const features = json.features || [];
          if (features.length === 0) {
            html = "<b>No features at this point.</b>";
          } else {
            // Show all features found, not just the first one
            html =
              "<div style='max-height: 600px; overflow-y: auto;'><b>Feature Info</b>";
            features.forEach((f: any, index: number) => {
              const props = f.properties || {};
              const layerName = f.id
                ? f.id.split(".")[0]
                : `Feature ${index + 1}`;
              html += `<div style="margin-top:${
                index > 0 ? "12px" : "6px"
              };"><strong>${layerName}</strong><table style="margin-top:4px;">`;
              html += Object.entries(props)
                .map(
                  ([k, v]) =>
                    `<tr><td style="padding-right:8px;font-weight:600;">${k}</td><td>${String(
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
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
        gridTemplateColumns: "320px 1fr",
        height: "100vh",
      }}
    >
      {/* Sidebar: layer toggles */}
      <div
        style={{ padding: 12, borderRight: "1px solid #eee", overflow: "auto" }}
      >
        <h3 style={{ margin: "4px 0 12px" }}>WMS Map Viewer</h3>

        {/* Search Section */}
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "8px 0 8px", fontSize: 14 }}>🔍 Search</h4>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              type="text"
              placeholder="Search addresses..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSearch()}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 12,
                border: "1px solid #ccc",
                borderRadius: 4,
              }}
            />
            <button
              onClick={handleSearch}
              disabled={!searchTerm.trim() || isSearching}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                backgroundColor: "#007cba",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                opacity: !searchTerm.trim() || isSearching ? 0.6 : 1,
              }}
            >
              {isSearching ? "..." : "Search"}
            </button>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div
              style={{
                marginTop: 8,
                maxHeight: 120,
                overflow: "auto",
                border: "1px solid #ddd",
                borderRadius: 4,
                backgroundColor: "white",
              }}
            >
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  onClick={() => handleResultSelect(result)}
                  style={{
                    padding: "6px 8px",
                    fontSize: 11,
                    borderBottom: "1px solid #eee",
                    cursor: "pointer",
                    backgroundColor: "white",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f0f0f0";
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
                marginTop: 8,
                padding: 8,
                backgroundColor: "#fff3cd",
                borderRadius: 4,
                fontSize: 11,
                border: "1px solid #ffeaa7",
              }}
            >
              <strong>📍 Selected:</strong> {selectedResult.address}
              <br />
              <button
                onClick={() => {
                  setSelectedResult(null);
                  setNearbyFeatures([]);
                }}
                style={{
                  marginTop: 4,
                  padding: "2px 6px",
                  fontSize: 10,
                  backgroundColor: "#f39c12",
                  color: "white",
                  border: "none",
                  borderRadius: 2,
                  cursor: "pointer",
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
                marginTop: 8,
                padding: 8,
                backgroundColor: "#e8f5e8",
                borderRadius: 4,
                fontSize: 11,
                maxHeight: 100,
                overflow: "auto",
              }}
            >
              <strong>🏗️ Nearby Infrastructure:</strong>
              {nearbyFeatures.map((layer) => (
                <div key={layer.layerKey} style={{ marginTop: 4 }}>
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
              padding: 8,
              backgroundColor: "#f0f8ff",
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <strong>Target Location:</strong>
            <br />
            Lat: {urlParams.lat.toFixed(6)}
            <br />
            Lng: {urlParams.lng.toFixed(6)}
            <br />
            Radius: {urlParams.radius}m
          </div>
        )}

        <h4 style={{ margin: "8px 0 8px", fontSize: 14 }}>Layers</h4>

        {/* Button to show/hide available layers */}
        <button
          onClick={() => setShowAvailableLayers(!showAvailableLayers)}
          style={{
            marginBottom: 12,
            padding: "4px 8px",
            fontSize: 12,
            backgroundColor: "#f0f0f0",
            border: "1px solid #ccc",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {showAvailableLayers ? "Hide" : "Show"} Available Layers (
          {availableLayers.length})
        </button>

        {/* Show available layers from GetCapabilities */}
        {showAvailableLayers && (
          <div
            style={{
              marginBottom: 16,
              padding: 8,
              backgroundColor: "#f9f9f9",
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            <strong>Available layers from GetCapabilities:</strong>
            {availableLayers.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {availableLayers.map((layer) => (
                  <li key={layer} style={{ marginBottom: 2 }}>
                    <code>{layer}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, fontStyle: "italic" }}>Loading...</p>
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
                margin: "8px 0 6px",
                fontSize: 12,
                fontWeight: "bold",
                color: "#333",
                borderBottom: "1px solid #eee",
                paddingBottom: 2,
              }}
            >
              {group.title}
            </h5>
            {group.layers.map((l) => (
              <label
                key={l.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                  marginLeft: 8,
                  backgroundColor: visible.has(l.key)
                    ? "#e8f5e8"
                    : "transparent",
                  padding: "2px 4px",
                  borderRadius: "4px",
                  fontSize: 12,
                }}
              >
                <input
                  type="checkbox"
                  checked={visible.has(l.key)}
                  onChange={() => toggleLayer(l.key)}
                />
                <span>{l.title}</span>
                {visible.has(l.key) && (
                  <span style={{ fontSize: 9, color: "green" }}>✓</span>
                )}
              </label>
            ))}
          </div>
        ))}

        {/* Debug info */}
        <div style={{ marginTop: 16, fontSize: 11, opacity: 0.7 }}>
          <strong>Debug Info:</strong>
          <br />
          Active layers: {visibleLayerKeys.length}
          <br />
          Check browser console for loading errors
        </div>

        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.8 }}>
          <p>
            <strong>Usage:</strong>
            <br />
            • Click map for feature info
            <br />• Add ?lat=43.7&lng=-79.4&radius=500 to URL for spatial
            filtering
          </p>
          {spatialFilter && (
            <p style={{ marginTop: 8, color: "#ff7800" }}>
              🎯 <strong>Spatial filtering active!</strong>
              <br />
              Only showing data within {urlParams.radius}m of target.
            </p>
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
        {LAYERS.map((l, idx) =>
          visible.has(l.key) ? (
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
              opacity={0.8} // Make layers slightly transparent so they're more visible
              // Add spatial filtering if bounds are provided
              {...(spatialFilter && {
                // Add CQL_FILTER for spatial filtering (if your GeoServer supports it)
                cql_filter: spatialFilter
                  ? `BBOX(the_geom,${spatialFilter.getWest()},${spatialFilter.getSouth()},${spatialFilter.getEast()},${spatialFilter.getNorth()},'EPSG:4326')`
                  : undefined,
              })}
              eventHandlers={{
                loading: () => console.log(`Loading layer: ${l.key}`),
                load: () => console.log(`Loaded layer: ${l.key}`),
                tileerror: (e) =>
                  console.error(`Error loading layer ${l.key}:`, e),
              }}
            />
          ) : null
        )}

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
