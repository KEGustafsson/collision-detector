# Collision Detector - Comprehensive Test Plan

## Test Categories

### 1. Pure Utility Functions

#### 1.1 Distance Calculations
- **Test 1.1.1**: Equirectangular distance - short distances (< 5nm)
- **Test 1.1.2**: Haversine distance - long distances (> 5nm)
- **Test 1.1.3**: High latitude accuracy (60°N+)
- **Test 1.1.4**: Equator vs poles comparison
- **Test 1.1.5**: Zero distance (same position)

#### 1.2 Bearing Calculations
- **Test 1.2.1**: Cardinal directions (N, E, S, W)
- **Test 1.2.2**: Intercardinal directions (NE, SE, SW, NW)
- **Test 1.2.3**: Crossing ±180° longitude
- **Test 1.2.4**: Near poles
- **Test 1.2.5**: Zero bearing (same position)

#### 1.3 Destination Point
- **Test 1.3.1**: Known distance/bearing combinations
- **Test 1.3.2**: Round-trip (destination then back)
- **Test 1.3.3**: Cardinal directions
- **Test 1.3.4**: Long distances

### 2. CPA/TCPA Calculations

#### 2.1 Basic CPA Cases
- **Test 2.1.1**: Head-on collision course
  - Vessel A: 000°, 10kn, Position (0, 0)
  - Vessel B: 180°, 10kn, Position (0, 1nm)
  - Expected: CPA ≈ 0m, TCPA = 3min

- **Test 2.1.2**: Crossing collision (90° angle)
  - Vessel A: 090°, 10kn, Position (0, 0)
  - Vessel B: 180°, 10kn, Position (0.5nm, 0.5nm)
  - Expected: CPA ≈ 0m, TCPA > 0

- **Test 2.1.3**: Parallel courses (no collision)
  - Vessel A: 090°, 10kn, Position (0, 0)
  - Vessel B: 090°, 10kn, Position (0, 0.5nm)
  - Expected: CPA = current distance, TCPA = ∞

- **Test 2.1.4**: Diverging vessels
  - Vessel A: 000°, 10kn, Position (0, 0)
  - Vessel B: 180°, 10kn, Position (0, -1nm)
  - Expected: diverging = true

- **Test 2.1.5**: Overtaking (same direction, different speeds)
  - Vessel A: 000°, 15kn, Position (0, 0)
  - Vessel B: 000°, 10kn, Position (0, 0.2nm)
  - Expected: CPA < safe distance (will overtake)

#### 2.2 Edge Cases
- **Test 2.2.1**: Zero speed vessels (both stationary)
- **Test 2.2.2**: One vessel stationary
- **Test 2.2.3**: Same velocity (parallel, same speed)
- **Test 2.2.4**: Very slow vessels (< 0.5 m/s)
- **Test 2.2.5**: Fast vessels (> 20 m/s)
- **Test 2.2.6**: Missing course data
- **Test 2.2.7**: Missing speed data
- **Test 2.2.8**: Invalid course (> 2π or < 0)

#### 2.3 COLREGS Scenarios
- **Test 2.3.1**: Head-on (meeting)
  - Vessels on reciprocal courses
  - Expected: Collision risk if aligned

- **Test 2.3.2**: Crossing (port/starboard)
  - Vessel crossing from starboard
  - Expected: Give-way situation detection

- **Test 2.3.3**: Overtaking
  - Faster vessel overtaking slower
  - Expected: Safe if sufficient offset

### 3. Data Validation

#### 3.1 Position Validation
- **Test 3.1.1**: Valid positions
- **Test 3.1.2**: Invalid latitude (> 90°)
- **Test 3.1.3**: Invalid latitude (< -90°)
- **Test 3.1.4**: Invalid longitude (> 180°)
- **Test 3.1.5**: Invalid longitude (< -180°)
- **Test 3.1.6**: Null/undefined position

#### 3.2 Speed Validation
- **Test 3.2.1**: Valid speeds (0-50 m/s)
- **Test 3.2.2**: Negative speed (invalid)
- **Test 3.2.3**: Excessive speed (> 51.4 m/s)
- **Test 3.2.4**: Zero speed (valid - stationary)

#### 3.3 Position Jump Detection
- **Test 3.3.1**: Normal movement (valid)
- **Test 3.3.2**: GPS glitch (1000km jump in 1 second)
- **Test 3.3.3**: High-speed valid movement
- **Test 3.3.4**: Marginal cases (1.4x max speed)

### 4. Collision Detection Integration

#### 4.1 CPA-based Detection (Primary)
- **Test 4.1.1**: Collision within safe distance threshold
- **Test 4.1.2**: Collision just beyond threshold (no alarm)
- **Test 4.1.3**: Collision far in future (> time window)
- **Test 4.1.4**: Multiple collisions simultaneously

#### 4.2 Geometric Fallback
- **Test 4.2.1**: Vessel with no course data
- **Test 4.2.2**: Vessel with no speed data
- **Test 4.2.3**: Stationary vessel (conservative distance)
- **Test 4.2.4**: Two vessels without course/speed

#### 4.3 Distance Pre-filtering
- **Test 4.3.1**: Distant vessel (> max range) - should skip
- **Test 4.3.2**: Vessel just within range - should check
- **Test 4.3.3**: Performance with 50+ vessels

### 5. Alarm System

#### 5.1 Hysteresis Behavior
- **Test 5.1.1**: Alarm turns ON at threshold
  - CPA = 499m (threshold 500m)
  - Expected: Alarm ON

- **Test 5.1.2**: Alarm stays ON above original threshold
  - CPA = 520m (within hysteresis 500m + 200m)
  - Expected: Alarm still ON

- **Test 5.1.3**: Alarm turns OFF beyond hysteresis
  - CPA = 701m (beyond 500m + 200m)
  - Expected: Alarm OFF

- **Test 5.1.4**: No flapping near threshold
  - CPA oscillates 490m ↔ 510m
  - Expected: Alarm stays ON once triggered

#### 5.2 Alarm Data Content
- **Test 5.2.1**: CPA-based alarm includes CPA/TCPA data
- **Test 5.2.2**: Geometric alarm includes method indicator
- **Test 5.2.3**: Multiple vessels in alarm
- **Test 5.2.4**: Vessel info (course, speed, bearing, distance)

### 6. State Management

#### 6.1 Vessel Updates
- **Test 6.1.1**: Initial vessel creation
- **Test 6.1.2**: Update existing vessel data
- **Test 6.1.3**: Partial updates (only position)
- **Test 6.1.4**: Reject invalid updates

#### 6.2 Stale Data Removal
- **Test 6.2.1**: Vessel removed after timeout (600s)
- **Test 6.2.2**: Fresh vessel retained
- **Test 6.2.3**: Timestamp updates refresh timeout

### 7. Maritime Scenarios (Real-world)

#### 7.1 Harbor Entrance
- **Scenario**: Multiple vessels entering/exiting narrow channel
- **Test**: Proper collision detection, no false positives on parallel traffic

#### 7.2 Open Ocean Transit
- **Scenario**: Two vessels on crossing courses
- **Test**: Early warning (10+ min), CPA calculation accuracy

#### 7.3 Anchored Vessel
- **Scenario**: Moving vessel approaching anchored vessel
- **Test**: Geometric fallback activates, conservative distance

#### 7.4 Vessel at Berth
- **Scenario**: Stationary vessel, another passing
- **Test**: No false alarm if safe distance maintained

#### 7.5 High-Traffic Area
- **Scenario**: 20+ vessels in area
- **Test**: Performance, only actual threats alarmed

#### 7.6 High Latitude (Arctic)
- **Scenario**: 75°N latitude operations
- **Test**: Distance calculations remain accurate

### 8. Performance Tests

- **Test 8.1**: Response time with 1 vessel (< 10ms)
- **Test 8.2**: Response time with 50 vessels (< 100ms)
- **Test 8.3**: Memory usage (stable, no leaks)
- **Test 8.4**: Distance pre-filter effectiveness

### 9. Error Handling

- **Test 9.1**: Malformed delta messages
- **Test 9.2**: Missing required fields
- **Test 9.3**: NaN/Infinity values
- **Test 9.4**: Null vessel context

## Test Execution Order

1. **Unit Tests** (Functions 1-3): Pure functions, deterministic
2. **Integration Tests** (Functions 4-6): State management, collision detection
3. **Scenario Tests** (Function 7): Real-world cases
4. **Performance Tests** (Function 8): Load testing
5. **Error Tests** (Function 9): Robustness

## Success Criteria

### Critical (Must Pass)
- All CPA calculations correct (Tests 2.1.1 - 2.1.5)
- Data validation works (Test 3.*)
- Hysteresis prevents flapping (Test 5.1.4)
- No false positives on parallel traffic (Test 2.1.3)
- Position jump detection (Test 3.3.2)

### Important (Should Pass)
- All maritime scenarios (Test 7.*)
- Performance acceptable (Test 8.*)
- Edge cases handled (Test 2.2.*)

### Nice to Have
- COLREGS scenario recognition
- High latitude accuracy
- 50+ vessel performance

## Test Data Format

```javascript
{
  vessel1: {
    position: { latitude: 60.0, longitude: 24.0 },
    course: 0 * Math.PI / 180,  // radians, 0 = north
    speed: 5.144,  // m/s (10 knots)
    timestamp: Date.now()
  },
  vessel2: {
    position: { latitude: 60.05, longitude: 24.0 },
    course: 180 * Math.PI / 180,  // radians, south
    speed: 5.144,
    timestamp: Date.now()
  },
  expected: {
    cpaDistance: 0,  // meters
    tcpaSeconds: 180,  // seconds (3 min)
    collision: true
  }
}
```

## Test Environment

- Node.js version: 14+
- Test framework: Custom or Mocha
- Assertion library: Built-in assert
- Mock SignalK: Minimal mock for app object
