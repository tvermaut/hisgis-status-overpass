// HUC-tiles zonder zoomrestricties
const hucTiles = L.tileLayer('https://tileserver.huc.knaw.nl/{z}/{x}/{y}', {
    attribution: '&copy; <a href="https://huc.knaw.nl/">HUC</a>'
});
const osmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});

const map = L.map('map', {
    center: [52.1326, 5.2913],
    zoom: 8,
    layers: [hucTiles]
});

const baseMaps = {
    "HUC Tiles": hucTiles,
    "OpenStreetMap": osmTiles
};
L.control.layers(baseMaps).addTo(map);

const overpassUrl = 'https://overpass.huc.knaw.nl/api/interpreter?data=%5Bout%3Ajson%5D%3B%0Arelation%0A%20%20%5Bgebiedstype%3D%22kadastrale%20gemeente%22%5D%3B%0Aout%20geom%3B';

// --- GeoJSON conversie helpers ---
function isClosed(coords) {
    if (coords.length < 2) return false;
    const first = coords[0], last = coords[coords.length - 1];
    return first[0] === last[0] && first[1] === last[1];
}
function reverseRing(ring) {
    return [...ring].reverse();
}
function joinWays(ways) {
    let rings = ways.map(way => way.geometry.map(pt => [pt.lon, pt.lat]));
    let result = [];
    while (rings.length > 0) {
        let ring = rings.shift();
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < rings.length; i++) {
                let candidate = rings[i];
                if (ring[ring.length - 1][0] === candidate[0][0] && ring[ring.length - 1][1] === candidate[0][1]) {
                    ring = ring.concat(candidate.slice(1));
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
                if (ring[0][0] === candidate[candidate.length - 1][0] && ring[0][1] === candidate[candidate.length - 1][1]) {
                    ring = candidate.slice(0, -1).concat(ring);
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
                if (ring[ring.length - 1][0] === candidate[candidate.length - 1][0] && ring[ring.length - 1][1] === candidate[candidate.length - 1][1]) {
                    ring = ring.concat(reverseRing(candidate).slice(1));
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
                if (ring[0][0] === candidate[0][0] && ring[0][1] === candidate[0][1]) {
                    ring = reverseRing(candidate).slice(0, -1).concat(ring);
                    rings.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        if (!isClosed(ring)) {
            ring.push(ring[0]);
        }
        result.push(ring);
    }
    return result;
}
function overpassToGeoJSON(overpassJson) {
    const features = [];
    overpassJson.elements.forEach(el => {
        if (el.type === "relation" && el.members) {
            const outers = [];
            const inners = [];
            el.members.forEach(member => {
                if (member.type === "way" && member.geometry) {
                    if (member.role === "outer") {
                        outers.push(member);
                    } else if (member.role === "inner") {
                        inners.push(member);
                    }
                }
            });
            if (outers.length === 0) return;
            const outerRings = joinWays(outers);
            const innerRings = inners.length > 0 ? joinWays(inners) : [];
            if (outerRings.length === 1) {
                const coords = [outerRings[0]];
                innerRings.forEach(ring => coords.push(ring));
                features.push({
                    type: "Feature",
                    geometry: {
                        type: "Polygon",
                        coordinates: coords
                    },
                    properties: el.tags || {},
                    id: el.id
                });
            } else {
                const coords = outerRings.map(ring => [ring]);
                features.push({
                    type: "Feature",
                    geometry: {
                        type: "MultiPolygon",
                        coordinates: coords
                    },
                    properties: el.tags || {},
                    id: el.id
                });
            }
        }
    });
    return {
        type: "FeatureCollection",
        features: features
    };
}

// --- Laag en zoeken ---
let gemeenteLayer = null;
let featuresByName = {};

async function loadAndShow() {
    try {
        const response = await fetch(overpassUrl);
        if (!response.ok) throw new Error('Network response was not ok');
        const overpassJson = await response.json();
        const geojson = overpassToGeoJSON(overpassJson);
        if (geojson.features.length === 0) {
            alert('Geen polygonen gevonden in laag.');
            return;
        }
        gemeenteLayer = L.geoJSON(geojson, {
            style: {
                color: '#e31a1c',
                weight: 2,
                fillOpacity: 0.1
            },
            onEachFeature: function(feature, layer) {
                if (feature.properties && feature.properties.name) {
                    layer.bindPopup(feature.properties.name);
                }
            }
        }).addTo(map);
        featuresByName = {};
        geojson.features.forEach(f => {
            if (f.properties && f.properties.name) {
                featuresByName[f.properties.name.toLowerCase()] = f;
            }
        });
        document.getElementById('searchBtn').disabled = false;
        map.fitBounds(gemeenteLayer.getBounds());
        drawLabels();
    } catch (err) {
        alert('Fout bij laden of verwerken van Overpass-data: ' + err);
        console.error(err);
    }
}
loadAndShow();

document.getElementById('searchForm').addEventListener('submit', function(e) {
    e.preventDefault();
    const input = document.getElementById('searchInput').value.trim().toLowerCase();
    if (!input) return;
    if (!featuresByName[input]) {
        alert('Gemeente niet gevonden: ' + input);
        return;
    }
    gemeenteLayer.eachLayer(function(layer) {
        if (
            layer.feature &&
            layer.feature.properties &&
            layer.feature.properties.name &&
            layer.feature.properties.name.toLowerCase() === input
        ) {
            map.fitBounds(layer.getBounds(), {maxZoom: 13});
            layer.openPopup();
        }
    });
});
document.getElementById('searchInput').addEventListener('input', function() {
    document.getElementById('searchBtn').disabled = !this.value.trim();
});

// --- SVG labels in kaart-eenheden ---
const svgLayer = L.svg().addTo(map);
const svg = d3.select(svgLayer._container);

function polygonCentroid(coords) {
    let area = 0, x = 0, y = 0;
    for (let i = 0, len = coords.length, j = len - 1; i < len; j = i++) {
        const xi = coords[i][0], yi = coords[i][1];
        const xj = coords[j][0], yj = coords[j][1];
        const f = xi * yj - xj * yi;
        area += f;
        x += (xi + xj) * f;
        y += (yi + yj) * f;
    }
    area = area / 2;
    if (area === 0) return coords[0];
    x = x / (6 * area);
    y = y / (6 * area);
    return [x, y];
}
function breakLines(name, maxLen = 12) {
    const words = name.split(' ');
    let lines = [], line = '';
    for (let w of words) {
        if ((line + ' ' + w).trim().length > maxLen && line.length > 0) {
            lines.push(line.trim());
            line = w;
        } else {
            line += ' ' + w;
        }
    }
    if (line) lines.push(line.trim());
    return lines;
}
function metersPerPixel(lat, zoom) {
    const earthCircumference = 40075016.686;
    return earthCircumference * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom + 8);
}
function drawLabels() {
    svg.selectAll('g.gemeente-label').remove();
    if (!gemeenteLayer) return;
    gemeenteLayer.eachLayer(function(layer) {
        if (!layer.feature || !layer.feature.geometry) return;
        const name = layer.feature.properties && layer.feature.properties.name;
        if (!name) return;
        let rings = [];
        if (layer.feature.geometry.type === "Polygon") {
            rings = [layer.feature.geometry.coordinates[0]];
        } else if (layer.feature.geometry.type === "MultiPolygon") {
            rings = layer.feature.geometry.coordinates.map(poly => poly[0]);
        }
        let biggest = rings[0];
        let maxLen = 0;
        for (let ring of rings) {
            let len = 0;
            for (let i = 1; i < ring.length; i++) {
                len += Math.hypot(ring[i][0] - ring[i-1][0], ring[i][1] - ring[i-1][1]);
            }
            if (len > maxLen) {
                maxLen = len;
                biggest = ring;
            }
        }
        const centroid = polygonCentroid(biggest);
        const point = map.latLngToLayerPoint([centroid[1], centroid[0]]);
        const lines = breakLines(name, 12);
        // Bepaal maximale lettergrootte zodat label in de gemeente past:
        // Benadering: neem bbox van grootste ring, kies kleinste zijde als basis
        let minSide = Infinity;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of biggest) {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
        }
        minSide = Math.min(maxX - minX, maxY - minY);
        // Houd 80% van bbox over, deel door aantal regels
        const fontSizeMeters = Math.max(100, 0.8 * minSide / lines.length);
        const mpp = metersPerPixel(centroid[1], map.getZoom());
        const fontSizePx = fontSizeMeters / mpp;

        const g = svg.append('g')
            .attr('class', 'gemeente-label')
            .attr('transform', `translate(${point.x},${point.y})`);
        lines.forEach((line, i) => {
            g.append('text')
                .text(line)
                .attr('y', i * fontSizePx * 1.1)
                .attr('text-anchor', 'middle')
                .attr('font-size', fontSizePx)
                .attr('font-family', 'sans-serif')
                .attr('font-weight', 'bold');
        });
    });
}
map.on('zoomend moveend', drawLabels);
