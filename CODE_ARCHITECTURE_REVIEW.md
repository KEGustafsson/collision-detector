# Code Architecture & Quality Review

**Date**: 2025-12-30
**Focus**: Topology, design patterns, implementation quality

---

## Architecture Analysis

### Current Approach: Hybrid Geometric + CPA System

The implementation uses a **dual-paradigm approach**:

1. **Geometric Probability Zones**: Projects collision areas (triangles/diamonds) representing possible vessel positions
2. **CPA/TCPA Filtering**: Calculates relative motion and closest point of approach

**Is it Novel?**
No - this combines two standard maritime collision avoidance techniques:
- Geometric zones: Common in radar/ARPA systems
- CPA/TCPA: Standard COLREGS collision avoidance calculations

However, the **combination** creates architectural conflicts (detailed below).

---

## Critical Issues Found

### 🔴 **Issue #1: Architectural Conflict - Competing Paradigms**

**Problem**: Two incompatible collision detection philosophies running in parallel

**Geometric Zones Philosophy**:
```
"Vessel could be ANYWHERE in this probability area over next X minutes"
→ Conservative, accounts for uncertainty
→ No specific position at specific time
```

**CPA Philosophy**:
```
"Vessel will be at EXACT position P at time T"
→ Deterministic, assumes constant course/speed
→ Specific position at specific time
```

**The Conflict**:
```javascript
// We calculate geometric zones for ALL vessels
updCollisionArea(delta.context);  // "Vessel could be anywhere in zone"

// Then later filter with CPA
if(cpaData && cpaData.diverging) {
    return false;  // "Vessel will be at exact position - safe"
}
```

These are fundamentally different models that shouldn't be mixed this way.

**Recommendation**:
- **Option A**: Use CPA/TCPA as PRIMARY, geometric zones as FALLBACK (when CPA unavailable)
- **Option B**: Use geometric zones with uncertainty, skip CPA entirely
- **Current approach**: Wastes computation on geometric zones that CPA will reject

---

### 🔴 **Issue #2: Performance - Wrong Order of Operations**

**Current Flow** (inefficient):
```javascript
doOnValue(delta)
  ↓ Store all data updates
  ↓ Validate (AFTER storing - bug!)
  ↓ updCollisionArea() - ALWAYS called, expensive trigonometry
  ↓ chkCollision()
      ↓ Calculate CPA - might reject immediately
      ↓ Geometric intersection checks - wasted if CPA rejected
```

**Problem**: We calculate expensive collision zones for vessels that CPA will immediately reject.

**Example Waste**:
```javascript
// Vessel 30nm away on parallel course
updCollisionArea(vesselID);  // Calculates triangle with:
  - destinationPoint() × 3 (sin, cos, atan2)
  - Bounding box calculation
  - Array operations

// Then in chkCollision:
cpaData = calculateCPA(...);
if(cpaData.diverging) return false;  // All that work wasted!
```

**Optimal Flow**:
```javascript
doOnValue(delta)
  ↓ Validate BEFORE storing
  ↓ Store data
  ↓ Distance pre-filter (cheap)
  ↓ CPA check (cheap - linear math)
  ↓ IF risky → updCollisionArea() (expensive - only when needed)
  ↓ Geometric checks (final confirmation)
```

**Impact**: Current approach does ~3-5x more calculations than necessary.

---

### 🔴 **Issue #3: Data Validation Bugs**

#### Bug 3A: Validation Happens AFTER Data Storage

**Location**: index.js:176-186

```javascript
update.values.forEach(value => {
    switch(value.path){
    case "navigation.position":
        AIS[delta.context].position = value.value;  // ← STORED FIRST
        // ... all other cases store data ...
    };

    // THEN validate (AFTER data already stored!)
    if (!validateAISData(delta.context)) {
        delete AIS[delta.context];  // Cleaning up after the fact
        return;  // ← BUG: see below
    }
```

**Problem**: Invalid data gets stored temporarily, could be used by parallel processing.

**Fix**: Validate BEFORE storing:
```javascript
// Collect all updates first
const updates = {};
update.values.forEach(value => {
    switch(value.path) {
        case "navigation.position":
            updates.position = value.value;
            break;
        // ... collect all updates
    }
});

// Validate BEFORE applying
if(validateUpdates(updates)) {
    applyUpdates(delta.context, updates);
}
```

#### Bug 3B: Return in forEach Doesn't Exit Function

**Location**: index.js:177-179

```javascript
update.values.forEach(value => {
    if (!validateAISData(delta.context)) {
        delete AIS[delta.context];
        return;  // ← ONLY exits forEach callback, NOT doOnValue!
    }
```

**Problem**: `return` inside `forEach` only exits the callback, not the parent function. Processing continues!

**What Actually Happens**:
```javascript
forEach iteration 1: validation fails → return → exits THIS iteration
forEach iteration 2: continues processing! (vessel still exists)
forEach iteration 3: continues processing!
```

**Fix**: Use flag or for-loop with break:
```javascript
let validationFailed = false;
for(const value of update.values) {
    if (!validateAISData(delta.context)) {
        delete AIS[delta.context];
        validationFailed = true;
        break;  // Actually exits the loop
    }
}
if(validationFailed) continue;  // Skip to next update
```

---

### 🔴 **Issue #4: CPA Calculation Bugs**

#### Bug 4A: Incorrect Relative Position Calculation

**Location**: index.js:396-404

```javascript
const relPosX = equirectangularDistance(
    {latitude: vessel1.position.latitude, longitude: vessel2.position.longitude},
    vessel1.position
) * (vessel1.position.longitude < vessel2.position.longitude ? -1 : 1);
```

**Problem**:
1. `equirectangularDistance()` always returns **positive** magnitude
2. Manual sign correction is incorrect for east/west determination
3. Doesn't account for longitude wrapping at ±180°

**Correct Approach**:
```javascript
// Calculate actual deltas
const dLon = (vessel2.position.longitude - vessel1.position.longitude) * Math.PI / 180;
const dLat = (vessel2.position.latitude - vessel1.position.latitude) * Math.PI / 180;

// Convert to meters with proper sign
const lat = vessel1.position.latitude * Math.PI / 180;
const relPosX = dLon * Math.cos(lat) * 6371000; // meters, signed
const relPosY = dLat * 6371000; // meters, signed
```

#### Bug 4B: Speed Check Rejects Zero

**Location**: index.js:376

```javascript
if(!vessel1.speed || !vessel2.speed) return null;
```

**Problem**: Speed of `0` is falsy in JavaScript, so stationary vessels (speed = 0) are rejected.

**Fix**:
```javascript
if(vessel1.speed === undefined || vessel2.speed === undefined) return null;
if(vessel1.speed === null || vessel2.speed === null) return null;
```

#### Bug 4C: Same-Speed Vessels Rejected

**Location**: index.js:393

```javascript
const relSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);
if(relSpeed < 0.1) return null;
```

**Problem**: Two vessels traveling at same speed in same direction (e.g., convoy, parallel traffic) have `relSpeed ≈ 0`. This rejects them, but they might still be on collision course if laterally offset.

**Example**:
```
Vessel A: Course 090°, Speed 10kt, Position (0, 0)
Vessel B: Course 090°, Speed 10kt, Position (0, 0.1nm)  ← 100m apart!

relSpeed = 0 → CPA returns null → No alarm!
But they're on COLLISION COURSE (if heading for same waypoint)
```

**Fix**: Allow zero relative speed, return CPA as current distance:
```javascript
if(relSpeed < 0.01) {
    // Same velocity - CPA is current distance, TCPA is infinity
    const currentDist = Math.sqrt(relPosX * relPosX + relPosY * relPosY);
    return {
        diverging: false,
        tcpa: Infinity,
        cpaDistance: currentDist,
        relativeSpeed: 0
    };
}
```

---

### 🔴 **Issue #5: Hysteresis Not Implemented**

**Location**: index.js:52, 45

```javascript
// DECLARED but never used:
var alarmState = false; // Track alarm state for hysteresis

// alarmHysteresisMeters option exists:
alarmHysteresisMeters: {
    type: 'number',
    title: 'Alarm hysteresis (meters)',
    description: 'Difference between alarm on/off thresholds to prevent flapping',
    default: 200
}
```

**Problem**: The `alarmState` variable and `alarmHysteresisMeters` config exist but are **never used**. The `collisionAlarm()` function doesn't implement hysteresis.

**Current Behavior** (alarm flapping):
```
T=0: CPA = 501m → No alarm
T=1: CPA = 499m → ALARM!
T=2: CPA = 501m → No alarm
T=3: CPA = 499m → ALARM!
[Flapping between states]
```

**Expected Behavior** (with hysteresis):
```
T=0: CPA = 501m → No alarm (state: OFF)
T=1: CPA = 499m → ALARM! (state: ON, threshold now 700m)
T=2: CPA = 501m → ALARM continues (still < 700m)
T=3: CPA = 701m → Alarm OFF (state: OFF, threshold now 500m)
```

**Fix**: Implement hysteresis in `collisionAlarm()`:
```javascript
function collisionAlarm(status=false) {
    if(status && !alarmState) {
        // Turn alarm ON
        alarmState = true;
        // Send alarm...
    } else if(!status && alarmState) {
        // Turn alarm OFF
        alarmState = false;
        // Clear alarm...
    }
    // If status matches alarmState, do nothing (hysteresis)
}
```

And in `chkCollision()`:
```javascript
// Use different thresholds based on alarm state
const threshold = alarmState ?
    (options.safePassingDistance + options.alarmHysteresisMeters) :
    options.safePassingDistance;

if(cpaData && cpaData.cpaDistance > threshold) {
    return false;
}
```

---

### 🔴 **Issue #6: Race Condition in Validation**

**Location**: index.js:151-163

```javascript
// Position jump detection
if (vessel.position && vessel.lastPosition && vessel.timestamp && vessel.lastTimestamp) {
    const distance = equirectangularDistance(vessel.lastPosition, vessel.position);
    const timeDelta = (vessel.timestamp - vessel.lastTimestamp) / 1000;
    // ...
}

// Save current position for next jump detection
if (vessel.position) {
    vessel.lastPosition = {longitude: vessel.position.longitude, latitude: vessel.position.latitude};
    vessel.lastTimestamp = vessel.timestamp;
}
```

**Problem**: Validation occurs AFTER updates, and lastPosition is saved even if validation fails.

**Race Condition**:
```
Update 1: Position A → validates OK → lastPosition = A
Update 2: Position B (GPS glitch, 1000km away) → validation fails, deleted
Update 3: Position C (valid) → compared to Position A (old), might fail jump check!
```

**Fix**: Only save lastPosition if validation passes:
```javascript
function validateAISData(vesselID) {
    // ... validation ...

    // ONLY save if validation passed
    if (validationPassed && vessel.position) {
        vessel.lastPosition = {...vessel.position};
        vessel.lastTimestamp = vessel.timestamp;
    }

    return validationPassed;
}
```

---

### 🟡 **Issue #7: Code Organization - Massive Closure**

**Location**: index.js:43-567 (entire plugin.start function)

**Problem**: All helper functions are defined inside `plugin.start()`, creating a 500+ line closure.

**Issues**:
1. **Not testable**: Can't unit test `calculateCPA()`, `validateAISData()`, etc.
2. **Memory overhead**: Each function instance captures entire closure scope
3. **Readability**: Hard to navigate 500+ line function
4. **Debugging**: Stack traces show nested anonymous functions

**Current Structure**:
```javascript
plugin.start = function (options, restartPlugin) {
    // 500+ lines including:
    function isDataFresh() { }
    function isMoving() { }
    function validateAISData() { }
    function doOnValue() { }
    function haversineDistance() { }
    function smartDistance() { }
    function isPointInPolygon() { }
    function updCollisionArea() { }
    function chkCollisions() { }
    function calculateCPA() { }
    function chkCollision() { }
    function collisionAlarm() { }
    // ... etc
};
```

**Recommendation**: Extract pure functions to module level:
```javascript
// Pure utility functions (no closure dependencies)
function haversineDistance(from, to) { }
function equirectangularDistance(from, to) { }
function isPointInPolygon(polygon, point) { }
function destinationPoint(from, distance, bearing) { }
function bearing(latlng1, latlng2) { }
function segmentIntersection(a1, a2, b1, b2) { }
function isInTriangle_Vector(A, B, C, P) { }

// Factory function for stateful logic
function createCollisionDetector(app, options) {
    const state = {
        AIS: {},
        collisions: {},
        alarmState: false,
        selfContext: null
    };

    return {
        processUpdate: function(delta) { },
        checkCollisions: function() { },
        // ... etc
    };
}

plugin.start = function (options, restartPlugin) {
    const detector = createCollisionDetector(app, options);
    // Subscribe and delegate to detector
};
```

**Benefits**:
- Each function can be unit tested
- Clearer dependencies
- Better performance (functions not recreated on each start)
- Easier to maintain

---

### 🟡 **Issue #8: Mixed Concerns in doOnValue()**

**Location**: index.js:175-208

**Problem**: Single function handles too many responsibilities:

```javascript
function doOnValue(delta) {
    // 1. Data parsing (switch statement)
    // 2. Data validation
    // 3. Data freshness checking
    // 4. Collision zone calculation
    // 5. Collision detection
    // 6. Alarm triggering
}
```

**Recommendation**: Separate concerns:
```javascript
function doOnValue(delta) {
    const updates = parseUpdates(delta);  // 1. Parse
    if(!validateUpdates(updates)) return; // 2. Validate

    applyUpdates(delta.context, updates); // Store

    if(!isDataFresh(delta.context)) {     // 3. Freshness
        removeVessel(delta.context);
        return;
    }

    scheduleCollisionCheck(delta.context); // 4-6. Async processing
}
```

---

### 🟡 **Issue #9: Magic Numbers**

**Scattered throughout code**:

```javascript
if(relSpeed < 0.1) return null;           // Line 393 - Why 0.1?
const quickDist = equirectangularDistance(from, to);
if (quickDist > 9260) {                   // Line 240 - Why 9260? (should be named constant)
const maxJumpSpeed = options.maxVesselSpeed * 1.5; // Line 157 - Why 1.5?
let aside = toFront/2;                    // Line 295 - Why /2?
const uncertaintyRad = options.courseUncertaintyDegrees * Math.PI / 180; // Should cache PI/180
```

**Recommendation**: Named constants:
```javascript
const CONSTANTS = {
    MIN_RELATIVE_SPEED: 0.1,              // m/s - minimum for CPA calculation
    HAVERSINE_DISTANCE_THRESHOLD: 9260,   // meters (5 nautical miles)
    POSITION_JUMP_MARGIN: 1.5,            // 50% margin over max speed
    DIAMOND_SIDE_RATIO: 0.5,              // Diamond side = forward distance / 2
    DEG_TO_RAD: Math.PI / 180,
    RAD_TO_DEG: 180 / Math.PI,
    EARTH_RADIUS: 6371000,                // meters
    METERS_PER_NM: 1852                   // nautical mile conversion
};
```

---

### 🟡 **Issue #10: Inconsistent Distance Functions**

**Problem**: Code uses both `equirectangularDistance()` and `smartDistance()` inconsistently.

**Mixed Usage**:
```javascript
// Line 152: Direct call
const distance = equirectangularDistance(vessel.lastPosition, vessel.position);

// Line 351: Smart distance
const distance = smartDistance(AIS[selfContext].position, AIS[vesselID].position);

// Line 411: Smart distance
"dist": smartDistance(AIS[selfContext].position, AIS[vesselID].position)

// Line 583, 584, 588, 589: Direct calls (in coordinate transformation)
const x = equirectangularDistance(...);
const y = equirectangularDistance(...);
```

**Recommendation**:
- Use `smartDistance()` for **actual distances** (collision detection, alarms)
- Use `equirectangularDistance()` only for **coordinate transformations** (local X/Y conversion)
- Document why each is used where

---

## Positive Architectural Elements ✅

### Good Design Choices:

1. **Schema-based configuration**: SignalK standard plugin configuration
2. **Subscription management**: Proper use of SignalK subscriptions with cleanup
3. **Delta stream processing**: Efficient incremental updates
4. **Helper function extraction**: Good separation (isMoving, isStationary, isDataFresh)
5. **Configurable parameters**: Allows tuning without code changes
6. **Progressive enhancement**: CPA is additive, doesn't break geometric fallback

---

## Recommendations Summary

### Priority 1: Fix Critical Bugs
1. Fix validation timing (validate BEFORE storing)
2. Fix return-in-forEach bug (use for-loop or flag)
3. Fix CPA relative position calculation (proper signed deltas)
4. Fix speed zero rejection (check undefined, not falsy)
5. Implement hysteresis (declared but not used)

### Priority 2: Architectural Improvements
6. Reverse order: CPA first, geometric zones only if needed
7. Extract functions from closure for testability
8. Separate concerns in doOnValue (parse → validate → store → process)
9. Named constants for magic numbers

### Priority 3: Enhancements
10. Add unit tests for pure functions
11. Add performance monitoring/metrics
12. Add alarm rate limiting
13. Consider vessel maneuverability in uncertainty
14. Add failsafe for CPA calculation failures

---

## Final Assessment

**Code Quality**: 5/10
- Individual functions are well-written
- But integration is poor
- Several critical bugs
- Needs refactoring

**Architecture**: 4/10
- Mixing two incompatible paradigms
- Wrong order of operations
- Massive closure anti-pattern
- Not testable

**Novel Approach?**: No
- Standard techniques combined
- Implementation has issues
- Not production-ready without fixes

**Recommendation**:
Refactor before deployment. The individual improvements are good, but the integration needs work. Consider choosing ONE primary collision detection method (recommend CPA/TCPA) with geometric zones as fallback for vessels with missing data.
