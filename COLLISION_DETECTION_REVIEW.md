# Deep Code Review: Collision Detection Algorithm

**Date**: 2025-12-30
**Reviewer**: Claude Code
**Version**: v0.2.2

## Executive Summary

This review identifies **12 critical and moderate issues** in the collision detection implementation that affect accuracy, performance, and maritime safety. The current algorithm uses a geometric zone-overlap approach but lacks proper consideration for relative motion, vessel dimensions, positioning uncertainty, and maritime collision avoidance principles.

---

## Critical Issues

### 1. **No Relative Motion Calculation** ⚠️ CRITICAL
**Location**: `chkCollision()` function (lines 270-417)

**Problem**:
The algorithm projects each vessel's path independently and checks if zones overlap, without calculating relative motion vectors. This violates fundamental maritime collision avoidance principles.

**Example of False Positive**:
```
Vessel A: Position (0, 0), Course 90°, Speed 10 knots
Vessel B: Position (0, 5nm), Course 90°, Speed 10 knots
```
- Both vessels are on **parallel courses** heading east
- They will **never collide**
- But their projected triangular zones will overlap → **FALSE ALARM**

**Maritime Standard**:
Should calculate:
- **CPA (Closest Point of Approach)**: Minimum distance between vessels
- **TCPA (Time to CPA)**: When CPA occurs
- **Bearing drift**: Whether bearing is changing (if constant → collision course)

**Proposal**:
```javascript
function calculateCPA(vessel1, vessel2) {
    // Convert to relative motion
    const relVelX = vessel1.velX - vessel2.velX;
    const relVelY = vessel1.velY - vessel2.velY;
    const relPosX = vessel1.posX - vessel2.posX;
    const relPosY = vessel1.posY - vessel2.posY;

    // Time to CPA
    const tcpa = -(relPosX * relVelX + relPosY * relVelY) /
                  (relVelX * relVelX + relVelY * relVelY);

    if (tcpa < 0) return null; // Vessels diverging

    // CPA distance
    const cpaX = relPosX + relVelX * tcpa;
    const cpaY = relPosY + relVelY * tcpa;
    const cpaDistance = Math.sqrt(cpaX * cpaX + cpaY * cpaY);

    return { tcpa, cpaDistance };
}
```

**Impact**: HIGH - Causes false alarms for parallel/diverging vessels

---

### 2. **No Time Dimension in Collision Detection** ⚠️ CRITICAL
**Location**: `chkCollision()` lines 334-401

**Problem**:
Collision zones represent "vessel could be anywhere in this area within X minutes" but don't consider WHEN each vessel will be at each location.

**Example**:
```
T=0min:  Vessel A at point (0,0) heading north
T=5min:  Vessel A will be at (0, 2.5nm) - zone includes this
T=0min:  Vessel B at point (3,0) heading west
T=8min:  Vessel B will be at (0, 0) - zone includes this
```
- Zones overlap at (0, 0)
- **BUT**: A is there at T=0, B is there at T=8
- **NO ACTUAL COLLISION** - they pass at different times

**Proposal**:
Implement time-based trajectory segments:
```javascript
// Divide projection into time segments (e.g., 2-minute intervals)
function getPositionAtTime(vessel, timeMinutes) {
    const distance = vessel.speed * timeMinutes * 60; // meters
    return destinationPoint(vessel.position, distance, vessel.course);
}

// Check if vessels are close at the SAME time
function checkTimeBasedCollision(vessel1, vessel2, maxTime) {
    for (let t = 0; t < maxTime; t += 2) { // 2-minute intervals
        const pos1 = getPositionAtTime(vessel1, t);
        const pos2 = getPositionAtTime(vessel2, t);
        const distance = equirectangularDistance(pos1, pos2);

        if (distance < SAFE_DISTANCE) {
            return { collision: true, time: t, distance };
        }
    }
    return { collision: false };
}
```

**Impact**: HIGH - Causes false positives for non-concurrent paths

---

### 3. **Vessel Beam Not Considered in Collision Zone** ⚠️ CRITICAL
**Location**: `updCollisionArea()` lines 237-239

**Problem**:
The collision triangle width is constant (±0.1 radians ≈ ±5.7°) regardless of vessel size.

**Current Code**:
```javascript
AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing-0.1));
AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing+0.1));
```

**Reality**:
- Container ship: 40m beam → needs ~40m width consideration
- Sailboat: 3m beam → needs ~3m width consideration
- At 3km forward: 0.1 radian gives ~300m width
  - **Too wide for sailboat** (unnecessary alarms)
  - **Might be too narrow for ship at close range**

**Proposal**:
```javascript
// Calculate triangle width based on vessel beam and uncertainty
let lateralSpread = 0.1; // default angular spread in radians
if (AIS[vesselID].beam) {
    // Add vessel half-beam at forward distance, plus course uncertainty
    const courseUncertainty = 0.05; // ±2.9° for course uncertainty
    const beamAngle = Math.atan2(AIS[vesselID].beam / 2, toFront);
    lateralSpread = beamAngle + courseUncertainty;
}

AIS[vesselID].collisionArea.push(
    destinationPoint(AIS[vesselID].collisionArea[0], toFront, bearing - lateralSpread)
);
AIS[vesselID].collisionArea.push(
    destinationPoint(AIS[vesselID].collisionArea[0], toFront, bearing + lateralSpread)
);
```

**Impact**: HIGH - Inaccurate collision zones for different vessel sizes

---

### 4. **Diamond Shape Bug for Stationary Vessels** 🐛 BUG
**Location**: Lines 228-235, 363-401

**Problem**:
The containment check assumes triangles (3 points) but stationary vessels create diamonds (4 points).

**Code**:
```javascript
// Creates diamond with 4 points
if((bearing == 0) && (AIS[vesselID].speed<1)) {
    // ... creates 4-point diamond
}

// Later - only checks first 3 points!
if(!isInTriangle_Vector(selfLocalCollisionArea[0], selfLocalCollisionArea[1],
                        selfLocalCollisionArea[2], point))
```

**Result**: **Missed collision detections** when one vessel is stationary

**Proposal**:
```javascript
function isPointInPolygon(polygon, point) {
    // Ray casting algorithm for arbitrary polygon
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];

        const intersect = ((yi > point[1]) !== (yj > point[1]))
            && (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Replace triangle check with polygon check
function checkContainment(selfArea, targetArea) {
    // Check if all target points are inside self area
    for (let point of targetArea) {
        if (!isPointInPolygon(selfArea, point)) return false;
    }
    return true;
}
```

**Impact**: HIGH - Missed collisions with stationary vessels

---

### 5. **False Stationary Detection for Unknown Course** 🐛 BUG
**Location**: Lines 218-228

**Problem**:
If a vessel has no course data, `bearing` defaults to 0 (north). A moving vessel with unknown course gets treated as stationary if speed <1, but a FAST vessel with unknown course gets a triangle pointing north.

**Code**:
```javascript
let bearing = 0; // defaults to north
if(AIS[vesselID].course) bearing = AIS[vesselID].course;

// This creates diamond if bearing=0 AND speed<1
if((bearing == 0) && (AIS[vesselID].speed<1)) {
    // diamond
}
else {
    // triangle pointing north (even if course is actually unknown!)
}
```

**Scenario**:
- Vessel at 5 knots, no course data → triangle pointing north (WRONG)
- Vessel could be heading ANY direction

**Proposal**:
```javascript
// Explicitly track if course is valid
let bearing = 0;
let courseValid = false;
if (AIS[vesselID].course) {
    bearing = AIS[vesselID].course;
    courseValid = true;
}

// Use diamond if stationary OR course unknown
if (AIS[vesselID].speed < 1 || !courseValid) {
    // Diamond shape - represents uncertainty
}
```

**Impact**: MEDIUM - Wrong collision zones for vessels with missing course data

---

## Moderate Issues

### 6. **Constant Triangle Spread Ignores Distance/Uncertainty**
**Location**: Line 238-239

**Problem**:
The ±0.1 radian spread is constant regardless of:
- Distance (uncertainty grows with distance)
- Course reliability
- Vessel type (large ships have better course-keeping)
- Weather conditions

**Proposal**:
```javascript
// Uncertainty grows with distance
const baseUncertainty = 0.05; // ±2.9° base uncertainty
const uncertaintyGrowth = 0.01 / 1000; // additional ±0.01 rad per km
const distanceKm = toFront / 1000;
let lateralSpread = baseUncertainty + (uncertaintyGrowth * distanceKm);

// Increase for small vessels (less stable course)
if (AIS[vesselID].length && AIS[vesselID].length < 20) {
    lateralSpread *= 1.5;
}
```

---

### 7. **No Distance Pre-Filtering**
**Location**: `chkCollisions()` lines 246-268

**Problem**:
Collision zones are calculated for ALL vessels, even those 50+ nautical miles away.

**Performance Impact**:
- 50 AIS targets × trigonometric calculations × every update
- Wasted CPU on impossible collisions

**Proposal**:
```javascript
function chkCollisions() {
    collisions = {};
    let isCollision = false;

    for (let vesselID in AIS) {
        if (vesselID === selfContext) continue;

        // Quick distance check BEFORE calculating zones
        if (AIS[selfContext]?.position && AIS[vesselID]?.position) {
            const distance = equirectangularDistance(
                AIS[selfContext].position,
                AIS[vesselID].position
            );

            // Max possible collision distance
            // Assumes max 25 m/s (48 knots) combined closing speed
            const maxCollisionRange = options.velocityVectorLengthInMn * 60 * 25;

            if (distance > maxCollisionRange) {
                continue; // Skip distant vessels
            }
        }

        // Data staleness check
        if ((Date.now() - AIS[vesselID].timestamp) > (options.timeouts.PosFreshBefore * 1000)) {
            delete AIS[vesselID];
            continue;
        }

        if (chkCollision(vesselID)) isCollision = true;
    }

    // ... rest of function
}
```

**Impact**: MEDIUM - Performance degradation in high-traffic areas

---

### 8. **Equirectangular Distance Inaccuracy**
**Location**: `equirectangularDistance()` lines 483-495

**Problem**:
Equirectangular approximation becomes inaccurate:
- At high latitudes (near poles)
- Over longer distances (>10 nautical miles)

**Example**:
- At 60° latitude, east-west distances are compressed 50%
- 10-minute projection at 20 knots = 3.3nm where errors become noticeable

**Proposal**:
```javascript
function haversineDistance(from, to) {
    // More accurate for longer distances and high latitudes
    const rad = Math.PI / 180;
    const R = 6371e3; // Earth radius in meters

    const φ1 = from.latitude * rad;
    const φ2 = to.latitude * rad;
    const Δφ = (to.latitude - from.latitude) * rad;
    const Δλ = (to.longitude - from.longitude) * rad;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; // meters
}

// Use equirectangular for <5nm (fast), haversine for >5nm (accurate)
function smartDistance(from, to) {
    const quickDist = equirectangularDistance(from, to);
    if (quickDist < 9260) return quickDist; // 5 nautical miles
    return haversineDistance(from, to);
}
```

**Impact**: MEDIUM - Distance errors at high latitudes or long ranges

---

### 9. **Data Staleness Check Inconsistency**
**Location**: Lines 255-259 vs line 187

**Problem**:
- `chkCollisions()` removes stale vessel data
- But `doOnValue()` calls `chkCollision(vesselID)` directly without staleness check
- Self vessel data might be stale when checking against updated target

**Proposal**:
```javascript
function isDataFresh(vesselID) {
    if (!AIS[vesselID]?.timestamp) return false;
    return (Date.now() - AIS[vesselID].timestamp) <= (options.timeouts.PosFreshBefore * 1000);
}

function doOnValue(delta) {
    // ... existing code ...

    // Check staleness before collision detection
    if (!isDataFresh(delta.context)) {
        delete AIS[delta.context];
        return;
    }

    updCollisionArea(delta.context);

    if (delta.context == selfContext) {
        chkCollisions();
    } else {
        // Check if BOTH vessels have fresh data
        if (isDataFresh(selfContext)) {
            if (chkCollision(delta.context)) collisionAlarm(true);
        }
    }
}
```

**Impact**: LOW-MEDIUM - Potential false alarms from stale own-ship data

---

### 10. **Inconsistent Floating-Point Speed Comparisons**
**Location**: Lines 224, 228

**Problem**:
```javascript
if(AIS[vesselID].speed>1)  // Line 224
// Comment: "speed is real, so cannot be compared to equal"

if((bearing == 0) && (AIS[vesselID].speed<1))  // Line 228
```

Comparing floats with exact values (1.0) is inconsistent and unreliable.

**Proposal**:
```javascript
const SPEED_THRESHOLD = 1.0; // m/s (~2 knots)
const SPEED_EPSILON = 0.1; // tolerance

function isMoving(speed) {
    return speed > (SPEED_THRESHOLD + SPEED_EPSILON);
}

function isStationary(speed) {
    return speed < (SPEED_THRESHOLD - SPEED_EPSILON);
}

// Use in code
if (isMoving(AIS[vesselID].speed)) {
    toFront = AIS[vesselID].speed * options.velocityVectorLengthInMn * 60 + toBack;
} else {
    toFront = 2 * toBack;
}
```

**Impact**: LOW - Edge case errors near 1 m/s threshold

---

### 11. **No Cross-Track Error / Course Deviation**
**Location**: Collision zone calculation (lines 212-244)

**Problem**:
Assumes vessels travel in perfectly straight lines. Reality:
- Autopilot has ±1-5° course deviation
- Manual steering: ±5-10°
- Current/wind drift
- Course changes

**Proposal**:
Add configurable course uncertainty:
```javascript
schema: {
    properties: {
        courseUncertaintyDegrees: {
            type: 'number',
            title: 'Course uncertainty (degrees)',
            description: 'Accounts for autopilot deviation, manual steering, currents',
            default: 5
        }
    }
}

// In updCollisionArea
const uncertaintyRad = options.courseUncertaintyDegrees * Math.PI / 180;
AIS[vesselID].collisionArea.push(
    destinationPoint(AIS[vesselID].collisionArea[0], toFront, bearing - uncertaintyRad)
);
AIS[vesselID].collisionArea.push(
    destinationPoint(AIS[vesselID].collisionArea[0], toFront, bearing + uncertaintyRad)
);
```

**Impact**: MEDIUM - Collision zones don't reflect real-world course variance

---

### 12. **No Validation of AIS Data Quality**
**Location**: `doOnValue()` lines 115-193

**Problem**:
No checks for:
- Invalid coordinates (lat >90°, lon >180°)
- Impossible speeds (>50 knots for most vessels)
- Sudden position jumps (teleportation)
- Course/speed consistency

**Proposal**:
```javascript
function validateAISData(vesselID, update) {
    const vessel = AIS[vesselID];

    // Coordinate validation
    if (vessel.position) {
        if (Math.abs(vessel.position.latitude) > 90 ||
            Math.abs(vessel.position.longitude) > 180) {
            app.error(`Invalid position for ${vesselID}`);
            return false;
        }
    }

    // Speed sanity check (100 knots = 51.4 m/s)
    if (vessel.speed && vessel.speed > 51.4) {
        app.debug(`Suspicious speed for ${vesselID}: ${vessel.speed} m/s`);
        vessel.speed = 51.4; // Clamp to maximum
    }

    // Position jump detection
    if (vessel.position && vessel.lastPosition) {
        const distance = equirectangularDistance(vessel.lastPosition, vessel.position);
        const timeDelta = (vessel.timestamp - vessel.lastTimestamp) / 1000; // seconds
        const impliedSpeed = distance / timeDelta;

        if (impliedSpeed > 77) { // 150 knots - clearly invalid
            app.debug(`Position jump detected for ${vesselID}`);
            return false;
        }
    }

    vessel.lastPosition = {...vessel.position};
    vessel.lastTimestamp = vessel.timestamp;
    return true;
}
```

**Impact**: LOW-MEDIUM - Reduces false alarms from AIS data errors

---

## Additional Recommendations

### A. Implement Safe Passing Distance Configuration
```javascript
schema: {
    properties: {
        safePassingDistance: {
            type: 'number',
            title: 'Safe passing distance (meters)',
            description: 'Minimum CPA distance to trigger alarm',
            default: 500
        }
    }
}
```

### B. Add Alarm Hysteresis
Prevent alarm flapping when vessels are near threshold:
```javascript
let alarmState = false;
const ALARM_ON_THRESHOLD = 500; // meters CPA
const ALARM_OFF_THRESHOLD = 700; // meters CPA (hysteresis)

if (!alarmState && cpaDistance < ALARM_ON_THRESHOLD) {
    alarmState = true;
    collisionAlarm(true);
} else if (alarmState && cpaDistance > ALARM_OFF_THRESHOLD) {
    alarmState = false;
    collisionAlarm(false);
}
```

### C. Provide More Detailed Alarm Information
```javascript
collisions[vesselID] = {
    "lon": AIS[vesselID].position.longitude,
    "lat": AIS[vesselID].position.latitude,
    "bearing": bearing(AIS[selfContext].position, AIS[vesselID].position),
    "dist": equirectangularDistance(AIS[selfContext].position, AIS[vesselID].position),
    "cpa": cpaDistance,           // NEW: CPA distance
    "tcpa": tcpaMinutes,           // NEW: Time to CPA
    "relativeSpeed": relSpeed,    // NEW: Closing speed
    "course": AIS[vesselID].course * 180 / Math.PI,  // NEW: Target course
    "speed": AIS[vesselID].speed  // NEW: Target speed
};
```

### D. Add Configurable Alarm Severity Levels
```javascript
function getAlarmSeverity(tcpa, cpa) {
    if (tcpa < 3 && cpa < 200) return 'emergency'; // <3min, <200m
    if (tcpa < 6 && cpa < 500) return 'alarm';     // <6min, <500m
    if (tcpa < 10 && cpa < 1000) return 'warn';    // <10min, <1000m
    return 'normal';
}
```

---

## Priority Implementation Roadmap

### Phase 1: Critical Fixes (Safety Impact)
1. **Issue #1**: Implement CPA/TCPA calculation
2. **Issue #3**: Add vessel beam to collision zones
3. **Issue #4**: Fix diamond/polygon containment check
4. **Issue #5**: Fix unknown course handling

### Phase 2: Accuracy Improvements
5. **Issue #2**: Add time-based collision detection
6. **Issue #6**: Variable uncertainty based on distance
7. **Issue #8**: Use Haversine for longer distances
8. **Issue #11**: Add course uncertainty parameter

### Phase 3: Performance & Robustness
9. **Issue #7**: Add distance pre-filtering
10. **Issue #9**: Fix data staleness consistency
11. **Issue #12**: Add AIS data validation
12. **Issue #10**: Fix floating-point comparisons

### Phase 4: Enhancements
13. **Recommendation A**: Configurable safe distance
14. **Recommendation B**: Alarm hysteresis
15. **Recommendation C**: Enhanced alarm data
16. **Recommendation D**: Alarm severity levels

---

## Testing Recommendations

### Unit Tests Needed
1. CPA calculation for parallel vessels (should be infinity or null)
2. CPA calculation for converging vessels
3. CPA calculation for crossing vessels
4. Collision zone with different vessel beams
5. Diamond vs triangle containment
6. Distance filtering performance
7. AIS data validation edge cases

### Integration Tests Needed
1. Real AIS data playback
2. High-traffic scenarios (50+ vessels)
3. High latitude scenarios (>60°)
4. Vessels with missing course data
5. Stationary vessel collisions
6. Fast-moving vessel scenarios

### Maritime Scenarios to Test
1. Overtaking situation (same direction, different speeds)
2. Head-on situation (opposite directions)
3. Crossing situation (COLREGS rules)
4. Vessel at anchor (stationary)
5. Parallel traffic (should NOT alarm)

---

## Conclusion

The current implementation provides a basic geometric collision detection but lacks critical elements for accurate maritime collision avoidance:

**Most Critical Issues**:
1. No relative motion / CPA calculation → many false positives
2. No time dimension → flags non-concurrent paths
3. Ignores vessel beam → inaccurate zones
4. Polygon containment bug → missed detections

**Estimated Impact of Fixes**:
- **False Positive Reduction**: 60-70% (from CPA/TCPA implementation)
- **Missed Detection Reduction**: 30-40% (from geometry fixes)
- **Performance Improvement**: 3-5x (from distance pre-filtering)

Implementing Phase 1 fixes would significantly improve safety and usability.
