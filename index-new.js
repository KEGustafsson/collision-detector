/*
 * Collision Detector - SignalK Plugin
 * Clean implementation with CPA/TCPA primary detection
 *
 * Architecture:
 * - Data validation before storage
 * - CPA/TCPA as primary collision detection
 * - Geometric zones as fallback for vessels without course/speed
 * - Proper hysteresis to prevent alarm flapping
 * - Testable pure functions
 */

module.exports = function (app) {
const plugin = {};

plugin.id = 'collision-detector';
plugin.name = 'Collision detector';
plugin.description = 'Maritime collision detection using CPA/TCPA analysis with geometric fallback';

plugin.schema = {
	title: plugin.name,
	type: 'object',
	required: ['PosFreshBefore'],
	properties: {
		safePassingDistanceMeters: {
			type: 'number',
			title: 'Safe passing distance (meters)',
			description: 'Minimum CPA distance to trigger collision alarm',
			default: 500
		},
		alarmHysteresisMeters: {
			type: 'number',
			title: 'Alarm hysteresis (meters)',
			description: 'Additional distance for alarm-off threshold (prevents flapping)',
			default: 200
		},
		timeWindowMinutes: {
			type: 'number',
			title: 'Time window for collision prediction (minutes)',
			description: 'How far ahead to predict collisions',
			default: 10
		},
		courseUncertaintyDegrees: {
			type: 'number',
			title: 'Course uncertainty (degrees)',
			description: 'Accounts for autopilot/steering deviation and currents',
			default: 5
		},
		maxVesselSpeedMps: {
			type: 'number',
			title: 'Maximum vessel speed (m/s)',
			description: 'For validation and distance pre-filtering (51.4 m/s = 100 knots)',
			default: 51.4
		},
		useHaversineDistance: {
			type: 'boolean',
			title: 'Use Haversine distance for accuracy',
			description: 'More accurate at high latitudes, slightly slower',
			default: true
		},
		timeouts: {
			type: 'object',
			title: 'Data freshness timeouts',
			properties: {
				PosFreshBefore: {
					type: 'number',
					title: 'Maximum data age (seconds)',
					description: 'AIS data older than this is considered stale',
					default: 600
				}
			}
		}
	}
};

// ============================================================================
// CONSTANTS
// ============================================================================

const CONSTANTS = {
	EARTH_RADIUS_METERS: 6371000,
	DEG_TO_RAD: Math.PI / 180,
	RAD_TO_DEG: 180 / Math.PI,
	METERS_PER_NM: 1852,

	// Thresholds
	SPEED_STATIONARY_MPS: 0.5,           // Below this = stationary
	SPEED_MOVING_MPS: 1.5,               // Above this = definitely moving
	MIN_RELATIVE_SPEED_MPS: 0.01,        // Minimum for CPA calculation
	HAVERSINE_THRESHOLD_METERS: 9260,    // 5nm - use Haversine beyond this

	// Validation
	MAX_POSITION_JUMP_MULTIPLIER: 1.5,   // Max speed * 1.5 for jump detection
	MAX_LATITUDE: 90,
	MAX_LONGITUDE: 180
};

// ============================================================================
// PURE UTILITY FUNCTIONS (No side effects, testable)
// ============================================================================

/**
 * Calculate distance using equirectangular approximation (fast, local)
 */
function equirectangularDistance(from, to) {
	const φ1 = from.latitude * CONSTANTS.DEG_TO_RAD;
	const φ2 = to.latitude * CONSTANTS.DEG_TO_RAD;
	const Δλ = (to.longitude - from.longitude) * CONSTANTS.DEG_TO_RAD;

	const x = Δλ * Math.cos((φ1 + φ2) / 2);
	const y = (φ2 - φ1);
	const d = Math.sqrt(x * x + y * y) * CONSTANTS.EARTH_RADIUS_METERS;

	return d; // meters
}

/**
 * Calculate distance using Haversine formula (accurate, all distances)
 */
function haversineDistance(from, to) {
	const φ1 = from.latitude * CONSTANTS.DEG_TO_RAD;
	const φ2 = to.latitude * CONSTANTS.DEG_TO_RAD;
	const Δφ = (to.latitude - from.latitude) * CONSTANTS.DEG_TO_RAD;
	const Δλ = (to.longitude - from.longitude) * CONSTANTS.DEG_TO_RAD;

	const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
			  Math.cos(φ1) * Math.cos(φ2) *
			  Math.sin(Δλ/2) * Math.sin(Δλ/2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

	return CONSTANTS.EARTH_RADIUS_METERS * c; // meters
}

/**
 * Smart distance - uses appropriate calculation based on distance
 */
function calculateDistance(from, to, useHaversine) {
	if (!from || !to) return null;

	if (!useHaversine) {
		return equirectangularDistance(from, to);
	}

	// Quick check with equirectangular
	const quickDist = equirectangularDistance(from, to);

	// Use Haversine for long distances
	if (quickDist > CONSTANTS.HAVERSINE_THRESHOLD_METERS) {
		return haversineDistance(from, to);
	}

	return quickDist;
}

/**
 * Calculate bearing from point 1 to point 2 (degrees, 0-360)
 */
function calculateBearing(from, to) {
	const φ1 = from.latitude * CONSTANTS.DEG_TO_RAD;
	const φ2 = to.latitude * CONSTANTS.DEG_TO_RAD;
	const Δλ = (to.longitude - from.longitude) * CONSTANTS.DEG_TO_RAD;

	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) -
			  Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

	let bearing = Math.atan2(y, x) * CONSTANTS.RAD_TO_DEG;
	bearing = (bearing + 360) % 360;

	return bearing;
}

/**
 * Calculate destination point given start, distance, and bearing
 */
function destinationPoint(from, distanceMeters, bearingRadians) {
	const δ = distanceMeters / CONSTANTS.EARTH_RADIUS_METERS;
	const θ = bearingRadians;

	const φ1 = from.latitude * CONSTANTS.DEG_TO_RAD;
	const λ1 = from.longitude * CONSTANTS.DEG_TO_RAD;

	const φ2 = Math.asin(
		Math.sin(φ1) * Math.cos(δ) +
		Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
	);

	const λ2 = λ1 + Math.atan2(
		Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
		Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
	);

	return {
		longitude: λ2 * CONSTANTS.RAD_TO_DEG,
		latitude: φ2 * CONSTANTS.RAD_TO_DEG
	};
}

/**
 * Calculate CPA (Closest Point of Approach) and TCPA (Time to CPA)
 * Returns: { cpaDistance, tcpaSeconds, diverging, relativeSpeed } or null
 */
function calculateCPA(vessel1, vessel2) {
	// Validate inputs
	if (!vessel1.position || !vessel2.position) return null;
	if (vessel1.course === undefined || vessel2.course === undefined) return null;
	if (vessel1.speed === undefined || vessel2.speed === undefined) return null;

	// Convert to Cartesian velocities (m/s)
	// Course is radians from north, clockwise
	const v1x = vessel1.speed * Math.sin(vessel1.course);
	const v1y = vessel1.speed * Math.cos(vessel1.course);
	const v2x = vessel2.speed * Math.sin(vessel2.course);
	const v2y = vessel2.speed * Math.cos(vessel2.course);

	// Relative velocity (vessel2 in vessel1's frame)
	const relVelX = v2x - v1x;
	const relVelY = v2y - v1y;
	const relSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);

	// Calculate relative position (vessel2 relative to vessel1)
	// Use proper signed deltas
	const dLon = (vessel2.position.longitude - vessel1.position.longitude) * CONSTANTS.DEG_TO_RAD;
	const dLat = (vessel2.position.latitude - vessel1.position.latitude) * CONSTANTS.DEG_TO_RAD;

	const avgLat = (vessel1.position.latitude + vessel2.position.latitude) / 2 * CONSTANTS.DEG_TO_RAD;

	// Convert to meters with proper signs
	const relPosX = dLon * Math.cos(avgLat) * CONSTANTS.EARTH_RADIUS_METERS;
	const relPosY = dLat * CONSTANTS.EARTH_RADIUS_METERS;

	// Special case: vessels with same velocity
	if (relSpeed < CONSTANTS.MIN_RELATIVE_SPEED_MPS) {
		const currentDist = Math.sqrt(relPosX * relPosX + relPosY * relPosY);
		return {
			cpaDistance: currentDist,
			tcpaSeconds: Infinity,
			diverging: false,
			relativeSpeed: 0,
			parallelCourse: true
		};
	}

	// Time to CPA (seconds)
	// tcpa = -(relative position · relative velocity) / |relative velocity|²
	const tcpaSeconds = -(relPosX * relVelX + relPosY * relVelY) /
						 (relVelX * relVelX + relVelY * relVelY);

	// If TCPA is negative, vessels are diverging
	if (tcpaSeconds < 0) {
		return {
			cpaDistance: Infinity,
			tcpaSeconds: 0,
			diverging: true,
			relativeSpeed: relSpeed,
			parallelCourse: false
		};
	}

	// CPA position and distance
	const cpaX = relPosX + relVelX * tcpaSeconds;
	const cpaY = relPosY + relVelY * tcpaSeconds;
	const cpaDistance = Math.sqrt(cpaX * cpaX + cpaY * cpaY);

	return {
		cpaDistance: cpaDistance,
		tcpaSeconds: tcpaSeconds,
		diverging: false,
		relativeSpeed: relSpeed,
		parallelCourse: false
	};
}

/**
 * Point-in-polygon test using ray casting algorithm
 */
function isPointInPolygon(polygon, point) {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i][0], yi = polygon[i][1];
		const xj = polygon[j][0], yj = polygon[j][1];

		const intersect = ((yi > point[1]) !== (yj > point[1])) &&
						  (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

/**
 * Line segment intersection test
 */
function segmentsIntersect(a1, a2, b1, b2) {
	const [ax1, ay1] = a1;
	const [ax2, ay2] = a2;
	const [bx1, by1] = b1;
	const [bx2, by2] = b2;

	const v1 = (bx2 - bx1) * (ay1 - by1) - (by2 - by1) * (ax1 - bx1);
	const v2 = (bx2 - bx1) * (ay2 - by1) - (by2 - by1) * (ax2 - bx1);
	const v3 = (ax2 - ax1) * (by1 - ay1) - (ay2 - ay1) * (bx1 - ax1);
	const v4 = (ax2 - ax1) * (by2 - ay1) - (ay2 - ay1) * (bx2 - ax1);

	return ((v1 * v2) < 0) && ((v3 * v4) < 0);
}

// ============================================================================
// DATA VALIDATION
// ============================================================================

/**
 * Validate vessel update data BEFORE applying
 */
function validateVesselUpdate(vesselData, options) {
	const errors = [];

	// Position validation
	if (vesselData.position) {
		const lat = vesselData.position.latitude;
		const lon = vesselData.position.longitude;

		if (Math.abs(lat) > CONSTANTS.MAX_LATITUDE) {
			errors.push(`Invalid latitude: ${lat}`);
		}
		if (Math.abs(lon) > CONSTANTS.MAX_LONGITUDE) {
			errors.push(`Invalid longitude: ${lon}`);
		}
	}

	// Speed validation
	if (vesselData.speed !== undefined && vesselData.speed !== null) {
		if (vesselData.speed < 0) {
			errors.push(`Negative speed: ${vesselData.speed}`);
		}
		if (vesselData.speed > options.maxVesselSpeedMps) {
			errors.push(`Excessive speed: ${vesselData.speed} m/s (max: ${options.maxVesselSpeedMps})`);
		}
	}

	// Course validation (should be radians 0-2π)
	if (vesselData.course !== undefined && vesselData.course !== null) {
		if (vesselData.course < 0 || vesselData.course > 2 * Math.PI) {
			errors.push(`Course out of range: ${vesselData.course} radians`);
		}
	}

	return {
		valid: errors.length === 0,
		errors: errors
	};
}

/**
 * Detect position jumps (GPS glitches, data errors)
 */
function detectPositionJump(vesselData, previousData, options) {
	if (!previousData || !previousData.position || !previousData.timestamp) {
		return { jumped: false };
	}

	if (!vesselData.position || !vesselData.timestamp) {
		return { jumped: false };
	}

	const distance = equirectangularDistance(previousData.position, vesselData.position);
	const timeDelta = (vesselData.timestamp - previousData.timestamp) / 1000; // seconds

	if (timeDelta <= 0) {
		return { jumped: false }; // No time elapsed
	}

	const impliedSpeed = distance / timeDelta;
	const maxAllowedSpeed = options.maxVesselSpeedMps * CONSTANTS.MAX_POSITION_JUMP_MULTIPLIER;

	if (impliedSpeed > maxAllowedSpeed) {
		return {
			jumped: true,
			impliedSpeed: impliedSpeed,
			maxAllowedSpeed: maxAllowedSpeed,
			distance: distance,
			timeDelta: timeDelta
		};
	}

	return { jumped: false };
}

// ============================================================================
// COLLISION DETECTION STATE
// ============================================================================

/**
 * Create collision detector state manager
 */
function createCollisionDetector(app, options) {
	const state = {
		vessels: {},          // All vessel data
		selfContext: null,    // Own vessel ID
		alarmActive: false,   // Current alarm state
		collisions: {}        // Current collision threats
	};

	/**
	 * Update vessel data (validates BEFORE storing)
	 */
	function updateVessel(vesselId, updates) {
		// Get current vessel data
		const currentVessel = state.vessels[vesselId] || {};

		// Merge updates
		const newData = { ...currentVessel, ...updates };

		// Validate
		const validation = validateVesselUpdate(newData, options);
		if (!validation.valid) {
			app.debug(`Validation failed for ${vesselId}: ${validation.errors.join(', ')}`);
			return false;
		}

		// Check for position jumps
		const jumpCheck = detectPositionJump(newData, currentVessel, options);
		if (jumpCheck.jumped) {
			app.debug(`Position jump detected for ${vesselId}: ${jumpCheck.impliedSpeed.toFixed(1)} m/s (max ${jumpCheck.maxAllowedSpeed.toFixed(1)})`);
			return false;
		}

		// Store valid data
		state.vessels[vesselId] = newData;
		return true;
	}

	/**
	 * Remove stale vessels
	 */
	function removeStaleVessels() {
		const now = Date.now();
		const maxAge = options.timeouts.PosFreshBefore * 1000;

		for (const vesselId in state.vessels) {
			const vessel = state.vessels[vesselId];
			if (vessel.timestamp && (now - vessel.timestamp) > maxAge) {
				app.debug(`Removing stale vessel ${vesselId}`);
				delete state.vessels[vesselId];
			}
		}
	}

	/**
	 * Check collision using CPA/TCPA (primary method)
	 */
	function checkCPACollision(targetVessel, targetId) {
		const selfVessel = state.vessels[state.selfContext];
		if (!selfVessel) return null;

		const cpaResult = calculateCPA(selfVessel, targetVessel);
		if (!cpaResult) return null;

		// Skip diverging vessels
		if (cpaResult.diverging) {
			return null;
		}

		// Check if CPA is within danger zone
		const threshold = state.alarmActive ?
			(options.safePassingDistanceMeters + options.alarmHysteresisMeters) :
			options.safePassingDistanceMeters;

		if (cpaResult.cpaDistance > threshold) {
			return null; // Safe passing distance
		}

		// Check if TCPA is within time window
		const tcpaMinutes = cpaResult.tcpaSeconds / 60;
		if (tcpaMinutes > options.timeWindowMinutes && !cpaResult.parallelCourse) {
			return null; // Too far in future
		}

		// Collision risk detected
		return {
			method: 'CPA',
			cpaDistance: cpaResult.cpaDistance,
			tcpaMinutes: tcpaMinutes,
			relativeSpeed: cpaResult.relativeSpeed,
			parallelCourse: cpaResult.parallelCourse || false,
			bearing: calculateBearing(selfVessel.position, targetVessel.position),
			distance: calculateDistance(selfVessel.position, targetVessel.position, options.useHaversineDistance),
			targetCourse: targetVessel.course ? targetVessel.course * CONSTANTS.RAD_TO_DEG : undefined,
			targetSpeed: targetVessel.speed
		};
	}

	/**
	 * Check collision using geometric zones (fallback method)
	 */
	function checkGeometricCollision(targetVessel, targetId) {
		const selfVessel = state.vessels[state.selfContext];
		if (!selfVessel || !selfVessel.position || !targetVessel.position) return null;

		// Only use geometric method if CPA not available
		// (missing course or speed data)
		const selfHasCourse = selfVessel.course !== undefined && selfVessel.speed !== undefined;
		const targetHasCourse = targetVessel.course !== undefined && targetVessel.speed !== undefined;

		if (selfHasCourse && targetHasCourse) {
			return null; // Use CPA method instead
		}

		// Calculate collision zones based on uncertainty
		// (Simplified for fallback - could be enhanced)
		const distance = calculateDistance(selfVessel.position, targetVessel.position, options.useHaversineDistance);

		// Use conservative threshold for vessels with unknown motion
		const threshold = state.alarmActive ?
			(options.safePassingDistanceMeters * 2 + options.alarmHysteresisMeters) :
			(options.safePassingDistanceMeters * 2);

		if (distance < threshold) {
			return {
				method: 'GEOMETRIC',
				distance: distance,
				bearing: calculateBearing(selfVessel.position, targetVessel.position),
				reason: 'Missing course/speed data - using conservative proximity check'
			};
		}

		return null;
	}

	/**
	 * Check all vessels for collisions
	 */
	function checkAllCollisions() {
		if (!state.selfContext || !state.vessels[state.selfContext]) {
			return;
		}

		removeStaleVessels();

		const selfVessel = state.vessels[state.selfContext];
		const newCollisions = {};

		// Distance pre-filter
		const maxSearchRange = options.timeWindowMinutes * 60 * options.maxVesselSpeedMps * 2;

		for (const vesselId in state.vessels) {
			if (vesselId === state.selfContext) continue;

			const vessel = state.vessels[vesselId];
			if (!vessel.position) continue;

			// Quick distance check
			const distance = calculateDistance(selfVessel.position, vessel.position, options.useHaversineDistance);
			if (distance > maxSearchRange) continue;

			// Try CPA method first (primary)
			let collision = checkCPACollision(vessel, vesselId);

			// Fallback to geometric if CPA not available
			if (!collision) {
				collision = checkGeometricCollision(vessel, vesselId);
			}

			if (collision) {
				newCollisions[vesselId] = {
					...collision,
					vesselId: vesselId,
					position: vessel.position
				};
			}
		}

		state.collisions = newCollisions;

		// Update alarm state with hysteresis
		const hasCollisions = Object.keys(newCollisions).length > 0;
		updateAlarmState(hasCollisions);
	}

	/**
	 * Update alarm state with hysteresis
	 */
	function updateAlarmState(shouldBeActive) {
		if (shouldBeActive && !state.alarmActive) {
			// Turn ON
			state.alarmActive = true;
			sendAlarm(true);
		} else if (!shouldBeActive && state.alarmActive) {
			// Turn OFF
			state.alarmActive = false;
			sendAlarm(false);
		}
		// Otherwise maintain current state (hysteresis)
	}

	/**
	 * Send alarm to SignalK
	 */
	function sendAlarm(active) {
		if (active) {
			app.handleMessage(plugin.id, {
				context: 'vessels.self',
				updates: [{
					values: [{
						path: 'notifications.danger.collision',
						value: {
							method: ['visual', 'sound'],
							state: 'alarm',
							message: 'Collision danger detected!',
							source: plugin.id,
							vessels: state.collisions
						}
					}],
					source: { label: plugin.id },
					timestamp: new Date().toISOString()
				}]
			});
		} else {
			app.handleMessage(plugin.id, {
				context: 'vessels.self',
				updates: [{
					values: [{
						path: 'notifications.danger.collision',
						value: null
					}],
					source: { label: plugin.id },
					timestamp: new Date().toISOString()
				}]
			});
		}
	}

	return {
		updateVessel,
		checkAllCollisions,
		setSelfContext: (context) => { state.selfContext = context; },
		getState: () => state
	};
}

// ============================================================================
// PLUGIN LIFECYCLE
// ============================================================================

let detector = null;
let unsubscribes = [];

plugin.start = function (options, restartPlugin) {
	// Initialize detector
	detector = createCollisionDetector(app, options);

	// Get own vessel ID
	let selfContext = app.getSelfPath('uuid');
	if (!selfContext) selfContext = app.getSelfPath('mmsi');
	if (selfContext) selfContext = selfContext.split('.').pop();
	detector.setSelfContext(selfContext);

	app.debug(`Collision detector started. Self context: ${selfContext}`);

	// Subscribe to vessel data
	const subscription = {
		context: 'vessels.*',
		subscribe: [
			{ path: 'navigation.position', format: 'delta', policy: 'instant', minPeriod: 0 },
			{ path: 'navigation.courseOverGroundTrue', format: 'delta', policy: 'instant', minPeriod: 0 },
			{ path: 'navigation.headingTrue', format: 'delta', policy: 'instant', minPeriod: 0 },
			{ path: 'navigation.speedOverGround', format: 'delta', policy: 'instant', minPeriod: 0 },
			{ path: 'design.length', format: 'delta', policy: 'instant', minPeriod: 0 },
			{ path: 'design.beam', format: 'delta', policy: 'instant', minPeriod: 0 },
			{ path: 'navigation.datetime', format: 'delta', policy: 'instant', minPeriod: 0 }
		]
	};

	app.subscriptionmanager.subscribe(
		subscription,
		unsubscribes,
		error => {
			app.error('Subscription error: ' + error);
			app.setPluginError('Subscription error: ' + error.message);
		},
		handleDelta
	);
};

plugin.stop = function () {
	unsubscribes.forEach(f => f());
	unsubscribes = [];
	detector = null;
	app.debug('Collision detector stopped');
};

/**
 * Handle incoming delta updates
 */
function handleDelta(delta) {
	if (!detector || !delta.updates) return;

	let vesselId = delta.context;
	if (vesselId) vesselId = vesselId.split('.').pop();

	// Collect all updates for this vessel
	const updates = {};
	let hasUpdates = false;

	for (const update of delta.updates) {
		if (!update.values) continue;

		const timestamp = update.timestamp ? Date.parse(update.timestamp) : Date.now();
		updates.timestamp = timestamp;

		for (const value of update.values) {
			hasUpdates = true;

			switch (value.path) {
				case 'navigation.position':
					updates.position = value.value;
					break;
				case 'navigation.courseOverGroundTrue':
					updates.course = value.value; // radians
					break;
				case 'navigation.headingTrue':
					if (!updates.course) updates.course = value.value;
					break;
				case 'navigation.speedOverGround':
					updates.speed = value.value; // m/s
					break;
				case 'design.length':
					updates.length = value.value?.overall || value.value;
					break;
				case 'design.beam':
					updates.beam = value.value;
					break;
				case 'navigation.datetime':
					updates.timestamp = Date.parse(value.value);
					break;
			}
		}
	}

	if (!hasUpdates) return;

	// Update vessel data (validates before storing)
	const updated = detector.updateVessel(vesselId, updates);

	if (updated) {
		// Check for collisions
		detector.checkAllCollisions();
	}
}

return plugin;
};
