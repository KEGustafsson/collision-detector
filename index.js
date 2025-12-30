/**/
module.exports = function (app) {
var plugin = {};

plugin.id = 'collision-detector';
plugin.name = 'Collision detector';
plugin.description = 'Server plugin that signaling of the collision possibility via SignalK alarm system';

plugin.schema = {
	title: plugin.name,
	description: '',
	type: 'object',
	required: ['PosFreshBefore'],
	properties: {
		velocityVectorLengthInMn:{
			type: 'number',
			title: 'Collision detection distance, minutes of movement.',
			description: '',
			default: 10
		},
		safePassingDistance:{
			type: 'number',
			title: 'Safe passing distance (meters)',
			description: 'Minimum CPA distance to trigger alarm',
			default: 500
		},
		courseUncertaintyDegrees:{
			type: 'number',
			title: 'Course uncertainty (degrees)',
			description: 'Accounts for autopilot deviation, manual steering, currents',
			default: 5
		},
		maxVesselSpeed:{
			type: 'number',
			title: 'Maximum vessel speed (m/s)',
			description: 'Used for distance pre-filtering and data validation',
			default: 51.4
		},
		useHaversineDistance:{
			type: 'boolean',
			title: 'Use Haversine distance calculation',
			description: 'More accurate for high latitudes and long distances, slightly slower',
			default: true
		},
		alarmHysteresisMeters:{
			type: 'number',
			title: 'Alarm hysteresis (meters)',
			description: 'Difference between alarm on/off thresholds to prevent flapping',
			default: 200
		},
		timeouts:{
			type: 'object',
			title: 'Data actuality timeouts',
			properties: {
				PosFreshBefore:{
					type: 'number',
					title: 'The position of AIS targets is considered correct no longer than this time, seconds.',
					description: `All devices on your network must have the same time (with differents less than 1 sec.) -- check this and you can be sure that you see actual data.`,
					default: 600
				}
			}
		}
	}
};

var unsubscribes = []; 	// массив функций, которые отписываются от подписок (на обновления от сервера, например)

// Constants
const SPEED_THRESHOLD = 1.0; // m/s (~2 knots)
const SPEED_EPSILON = 0.1; // tolerance for floating point comparisons

////////////////
plugin.start = function (options, restartPlugin) {
let self;
let selfContext = app.getSelfPath('uuid');
if(!selfContext) self = app.getSelfPath('mmsi');	// костыль на предмет https://github.com/SignalK/signalk-server/issues/1447
// идентификатор будет без SignalK's пути, каким бы он ни был,
// а то этот путь слишком часто меняется с версией SignalK
if(selfContext) selfContext = selfContext.split('.').pop();
var AIS = {};
var collisions;
var alarmState = false; // Track alarm state for hysteresis
/////////////////////////// collisionDetector test ///////////////////////////////
//let collisionSegments;	// пересекающиеся отрезки, в тестовых целях
/////////////////////////// end collisionDetector test ///////////////////////////////
//app.debug('self',self,app.getSelfPath('navigation.datetime'));

// Подписка на изменение положения всех судов
// На что подписываемся
const TPVsubscribe = {
	"context": "vessels.*",
	"subscribe": [
		{
			"path": "navigation.position",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.courseOverGroundTrue",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.headingTrue",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.speedOverGround",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "design.length",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "design.beam",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.datetime",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		}
	]
}
// Подписка
// документации на эту штуку так и нет, но удалось узнать, что вызывать это можно много раз с разными подписками
app.subscriptionmanager.subscribe(	
	TPVsubscribe,	// подписка
	unsubscribes,	// массив функций отписки
	subscriptionError => {	// обработчик ошибки
		app.error('Error subscription to data:' + subscriptionError);
		app.setPluginError('Error subscription to data:'+subscriptionError.message);
	},
	doOnValue	// функция обработки каждой delta
); // end subscriptionmanager

// Helper function to check if data is fresh
function isDataFresh(vesselID) {
	if (!AIS[vesselID]?.timestamp) return false;
	return (Date.now() - AIS[vesselID].timestamp) <= (options.timeouts.PosFreshBefore * 1000);
}

// Helper function to check if vessel is moving
function isMoving(speed) {
	return speed > (SPEED_THRESHOLD + SPEED_EPSILON);
}

// Helper function to check if vessel is stationary
function isStationary(speed) {
	return speed < (SPEED_THRESHOLD - SPEED_EPSILON);
}

// Validate AIS data quality
function validateAISData(vesselID) {
	const vessel = AIS[vesselID];
	if (!vessel) return false;

	// Coordinate validation
	if (vessel.position) {
		if (Math.abs(vessel.position.latitude) > 90 ||
			Math.abs(vessel.position.longitude) > 180) {
			app.error(`Invalid position for ${vesselID}: lat=${vessel.position.latitude}, lon=${vessel.position.longitude}`);
			return false;
		}
	}

	// Speed sanity check
	if (vessel.speed && vessel.speed > options.maxVesselSpeed) {
		app.debug(`Suspicious speed for ${vesselID}: ${vessel.speed} m/s, clamping to ${options.maxVesselSpeed}`);
		vessel.speed = options.maxVesselSpeed;
	}

	// Position jump detection
	if (vessel.position && vessel.lastPosition && vessel.timestamp && vessel.lastTimestamp) {
		const distance = equirectangularDistance(vessel.lastPosition, vessel.position);
		const timeDelta = (vessel.timestamp - vessel.lastTimestamp) / 1000; // seconds

		if (timeDelta > 0) {
			const impliedSpeed = distance / timeDelta;
			const maxJumpSpeed = options.maxVesselSpeed * 1.5; // Allow 50% margin

			if (impliedSpeed > maxJumpSpeed) {
				app.debug(`Position jump detected for ${vesselID}: implied speed ${impliedSpeed.toFixed(1)} m/s`);
				return false;
			}
		}
	}

	// Save current position for next jump detection
	if (vessel.position) {
		vessel.lastPosition = {longitude: vessel.position.longitude, latitude: vessel.position.latitude};
		vessel.lastTimestamp = vessel.timestamp;
	}

	return true;
}

// Обработчик сообщений подписки
function doOnValue(delta){	
//app.debug('Новое сообщение:',delta);
//app.debug('navigation.datetime',app.getSelfPath('navigation.datetime'));
for(const update of delta.updates) {
	//app.debug(update.source,update.timestamp);
	//app.debug('[doOnValue]','selfContext=',selfContext);
	//app.debug('[doOnValue]','delta.context=',delta.context);
	if(!update.values) continue;	// там может быть обновление meta, а не данных
	delta.context = delta.context.split('.').pop();	// идентификатор без пути
	let timestamp = update.timestamp;	
	update.values.forEach(value => {	// если подписка только на координаты -- здесь будут только координаты
		//app.debug(value);
		if(!selfContext && delta.context.endsWith(self)) selfContext = delta.context;
		if(!AIS[delta.context]) AIS[delta.context] = {};
		switch(value.path){
		case "navigation.position":
			AIS[delta.context].position = value.value;	// {longitude: xx, latitude: xx} degrees
			// Поскольку у целей AIS нет navigation.datetime, timestamp будет из изменения координат
			if(!AIS[delta.context].datetime) AIS[delta.context].timestamp = Date.parse(update.timestamp); 	// milliseconds
			/*
			// Будем определь возможность столкновения только при изменении координат
			// однако, повороты отдельно, и если не пересчитывать на каждый поворот -- так себе получается
			// Определим координаты точек опасной зоны и координаты объемлющего
			// горизонтального прямоугольника для этого судна
			updCollisionArea(delta.context);	// 
			if(delta.context == selfContext) {
				// Определим возможность столкновения нас со всеми судами
				chkCollisions();
			}
			else {
				// Определим возможность столкновения этого судна с нами
				if(chkCollision(delta.context)) collisionAlarm(true);
			}
			*/
			break;
		case "navigation.courseOverGroundTrue":
			AIS[delta.context].courseOverGroundTrue = value.value;	// radian
			if(!AIS[delta.context].headingTrue) AIS[delta.context].course = value.value
			//AIS[delta.context].course = value.value;	// radian
			break;
		case 'navigation.headingTrue':
			AIS[delta.context].heading = value.value;	// radian
			//if(!AIS[delta.context].courseOverGroundTrue) AIS[delta.context].course = value.value
			AIS[delta.context].course = value.value;	// radian
			break;
		case "navigation.speedOverGround":
			AIS[delta.context].speed = value.value;	// m/sec
			break;
		case "design.length":
			AIS[delta.context].length = value.value.overall;	// m
			break;
		case "design.beam":
			AIS[delta.context].beam = value.value;	// m
			break;
		case "navigation.datetime":
			// у целей AIS в SignalK этого нет, и откуда берётся таймштамп там -- неизвестно.
			AIS[delta.context].datetime = Date.parse(value.value); 	// milliseconds
			AIS[delta.context].timestamp = AIS[delta.context].datetime;
			break;
		};

		// Validate AIS data before processing
		if (!validateAISData(delta.context)) {
			delete AIS[delta.context];
			return;
		}

		// Check data freshness
		if (!isDataFresh(delta.context)) {
			delete AIS[delta.context];
			return;
		}

		// Будем определь возможность столкновения при изменении любых параметров
		// Это не менее чем в три раза чаще, чем только при изменении координат
		// Определим координаты точек опасной зоны и координаты объемлющего
		// горизонтального прямоугольника для этого судна
		updCollisionArea(delta.context);	//
		if(delta.context == selfContext) {
			// Определим возможность столкновения нас со всеми судами
			chkCollisions();
		}
		else {
			// Определим возможность столкновения этого судна с нами
			// Only check if self data is also fresh
			if(isDataFresh(selfContext)) {
				if(chkCollision(delta.context)) collisionAlarm(true);
			}
		}

	});
};
//app.debug(AIS);
}; 	// end function doOnValue
// Конец подписки на изменение положения всех судов

/*////////////////////////// collisionDetector test ///////////////////////////////
// Отладочный сервер
app.get(`/${plugin.id}/allvessels/`, function(request, response) {	
	response.json(AIS);
});
app.get(`/${plugin.id}/collisions/`, function(request, response) {	
	response.json(collisions);
});
/*////////////////////////// end collisionDetector test ///////////////////////////////





// Функции

// Haversine distance - more accurate for long distances and high latitudes
function haversineDistance(from, to) {
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

// Smart distance - use equirectangular for short distances, Haversine for long
function smartDistance(from, to) {
	if (!options.useHaversineDistance) {
		return equirectangularDistance(from, to);
	}

	// Quick check with equirectangular
	const quickDist = equirectangularDistance(from, to);

	// Use Haversine for distances >5nm (9260m) or if configured
	if (quickDist > 9260) {
		return haversineDistance(from, to);
	}

	return quickDist;
}

// Check if point is inside arbitrary polygon using ray casting
function isPointInPolygon(polygon, point) {
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

function updCollisionArea(vesselID){
// Определим координаты точек опасной зоны и координаты объемлющего
// горизонтального прямоугольника для vesselID
if(!AIS[vesselID].position) return;

// Vessel dimensions
let toBack = 30;	// метров (default)
if(AIS[vesselID].length) toBack = AIS[vesselID].length;

// Course tracking - explicitly track if course is valid
let bearing = 0;
let courseValid = false;
if(AIS[vesselID].course !== undefined && AIS[vesselID].course !== null) {
	bearing = AIS[vesselID].course;	// radian
	courseValid = true;
}

// Speed check
const speed = AIS[vesselID].speed || 0;

AIS[vesselID].collisionArea = [];
AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].position,toBack,bearing+Math.PI));	// назад

// Calculate forward distance based on speed
let toFront;
if(isMoving(speed)) {
	toFront = speed * options.velocityVectorLengthInMn * 60 + toBack;
} else {
	toFront = 2*toBack;
}

// Use diamond if stationary OR course unknown (more conservative)
if(isStationary(speed) || !courseValid) {
	// Diamond shape - represents uncertainty
	let aside = toFront/2;
	// Add vessel beam if available
	if(AIS[vesselID].beam && AIS[vesselID].beam > aside) {
		aside = AIS[vesselID].beam;
	}

	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].position,aside,bearing-Math.PI/2));
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing));
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].position,aside,bearing+Math.PI/2));
	AIS[vesselID].shapeType = 'diamond'; // Track shape type for containment check
}
else {
	// Triangle - moving vessel with known course
	// Calculate lateral spread based on uncertainty, distance, and vessel beam
	const uncertaintyRad = options.courseUncertaintyDegrees * Math.PI / 180;

	// Add vessel beam consideration at forward distance
	let beamAngle = 0;
	if(AIS[vesselID].beam && toFront > 0) {
		beamAngle = Math.atan2(AIS[vesselID].beam / 2, toFront);
	}

	// Combine beam and course uncertainty
	const lateralSpread = uncertaintyRad + beamAngle;

	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing-lateralSpread));
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing+lateralSpread));
	AIS[vesselID].shapeType = 'triangle'; // Track shape type for containment check
}

// Calculate bounding box
let longs = [], lats = [];
AIS[vesselID].collisionArea.forEach(point => {longs.push(point.longitude);lats.push(point.latitude)});
AIS[vesselID].squareArea = {topLeft: {longitude: Math.min.apply(null,longs), latitude: Math.max.apply(null,lats)},bottomRight: {longitude: Math.max.apply(null,longs), latitude: Math.min.apply(null,lats)}};
} // end function updCollisionArea

function chkCollisions(){
// Определим возможность столкновения нас со всеми судами
collisions = {};
/////////////////////////// collisionDetector test ///////////////////////////////
//collisionSegments = {}; 	// объект для тестовых целей
/////////////////////////// end collisionDetector test ///////////////////////////////
let isCollision = false;

for(let vesselID in AIS){
	if(vesselID === selfContext) continue;

	// Data staleness check
	if((Date.now()-AIS[vesselID].timestamp)>(options.timeouts.PosFreshBefore*1000)){
		//app.debug('Протухла информация о',vesselID);
		delete AIS[vesselID];
		continue;
	}

	// Distance pre-filtering - skip distant vessels for performance
	if(AIS[selfContext]?.position && AIS[vesselID]?.position) {
		const distance = smartDistance(AIS[selfContext].position, AIS[vesselID].position);

		// Max possible collision distance based on combined speed and time window
		// Assumes maximum vessel speed for conservative estimate
		const maxCollisionRange = options.velocityVectorLengthInMn * 60 * options.maxVesselSpeed * 2;

		if(distance > maxCollisionRange) {
			continue; // Skip distant vessels
		}
	}

	if(chkCollision(vesselID)) isCollision = true;
}

if(isCollision) collisionAlarm(true);	// хотя бы одна цель AIS
else {
	const isNotificationsCollision = app.getSelfPath('notifications.danger.collision');
	if(isNotificationsCollision && isNotificationsCollision.value) collisionAlarm(false);
	// а иначе оно и так false
}
} // end function chkCollisions

// Calculate CPA (Closest Point of Approach) and TCPA (Time to CPA)
function calculateCPA(vessel1, vessel2) {
	if(!vessel1.position || !vessel2.position) return null;
	if(!vessel1.speed || !vessel2.speed) return null;
	if(vessel1.course === undefined || vessel2.course === undefined) return null;

	// Convert to Cartesian velocities (m/s)
	const v1x = vessel1.speed * Math.sin(vessel1.course);
	const v1y = vessel1.speed * Math.cos(vessel1.course);
	const v2x = vessel2.speed * Math.sin(vessel2.course);
	const v2y = vessel2.speed * Math.cos(vessel2.course);

	// Relative velocity
	const relVelX = v1x - v2x;
	const relVelY = v1y - v2y;

	// Relative speed
	const relSpeed = Math.sqrt(relVelX * relVelX + relVelY * relVelY);

	// If vessels have same velocity, no CPA calculation possible
	if(relSpeed < 0.1) return null;

	// Relative position (approximate with equirectangular for local distances)
	const relPosX = equirectangularDistance(
		{latitude: vessel1.position.latitude, longitude: vessel2.position.longitude},
		vessel1.position
	) * (vessel1.position.longitude < vessel2.position.longitude ? -1 : 1);

	const relPosY = equirectangularDistance(
		{latitude: vessel2.position.latitude, longitude: vessel1.position.longitude},
		vessel1.position
	) * (vessel1.position.latitude < vessel2.position.latitude ? -1 : 1);

	// Time to CPA (seconds)
	const tcpa = -(relPosX * relVelX + relPosY * relVelY) / (relVelX * relVelX + relVelY * relVelY);

	// If TCPA is negative, vessels are diverging
	if(tcpa < 0) return { diverging: true, tcpa: 0, cpaDistance: Infinity };

	// CPA distance
	const cpaX = relPosX + relVelX * tcpa;
	const cpaY = relPosY + relVelY * tcpa;
	const cpaDistance = Math.sqrt(cpaX * cpaX + cpaY * cpaY);

	return {
		diverging: false,
		tcpa: tcpa / 60, // Convert to minutes
		cpaDistance: cpaDistance, // meters
		relativeSpeed: relSpeed // m/s
	};
}

function chkCollision(vesselID){
if(!selfContext || !AIS[vesselID] || !AIS[vesselID].squareArea || !AIS[selfContext] || !AIS[selfContext].squareArea) return false;

// Calculate CPA/TCPA for better collision detection
let cpaData = null;
if(AIS[selfContext].course !== undefined && AIS[vesselID].course !== undefined &&
   AIS[selfContext].speed && AIS[vesselID].speed) {
	cpaData = calculateCPA(AIS[selfContext], AIS[vesselID]);

	// Skip if vessels are diverging
	if(cpaData && cpaData.diverging) {
		return false;
	}

	// Skip if CPA distance is safe (with hysteresis)
	if(cpaData && cpaData.cpaDistance > (options.safePassingDistance + options.alarmHysteresisMeters)) {
		return false;
	}
}

// Проверяем пересечение прямоугольных областей
if(
	AIS[vesselID].squareArea.topLeft.longitude > AIS[selfContext].squareArea.bottomRight.longitude
	|| AIS[vesselID].squareArea.bottomRight.longitude < AIS[selfContext].squareArea.topLeft.longitude
	|| AIS[vesselID].squareArea.topLeft.latitude < AIS[selfContext].squareArea.bottomRight.latitude
	|| AIS[vesselID].squareArea.bottomRight.latitude > AIS[selfContext].squareArea.topLeft.latitude
) {
	//if(collisions.includes(vesselID)) {	// считаем, что собственное положение изменяется достаточно часто, а при этом массив collisions обнуляется.
	return false;	// эти области не пересекаются
}
// Области пересекаются -- определим общий горизонтальный прямоугольник
const unitedSquareArea = {
	topLeft: {
		longitude: Math.min(AIS[vesselID].squareArea.topLeft.longitude,AIS[selfContext].squareArea.topLeft.longitude), 
		latitude: Math.max(AIS[vesselID].squareArea.topLeft.latitude,AIS[selfContext].squareArea.topLeft.latitude)
	},
	bottomRight: {
		longitude: Math.max(AIS[vesselID].squareArea.bottomRight.longitude,AIS[selfContext].squareArea.bottomRight.longitude), 
		latitude: Math.min(AIS[vesselID].squareArea.bottomRight.latitude,AIS[selfContext].squareArea.bottomRight.latitude)
	}
};	// 
//app.debug('unitedSquareArea:',unitedSquareArea);
/*////////////////////////// collisionDetector test ///////////////////////////////
if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
if(!collisionSegments[vesselID].unitedSquareAreas) collisionSegments[vesselID].unitedSquareAreas = [];
collisionSegments[vesselID].unitedSquareAreas.push(unitedSquareArea);
/*////////////////////////// end collisionDetector test ///////////////////////////////

// Пересчитаем координаты точек collisionArea относительно общего прямоугольника,
// от верхнего левого угла, в метрах
let selfLocalCollisionArea = [], targetLocalCollisionArea = [];
AIS[selfContext].collisionArea.forEach(point=>{
	const x = equirectangularDistance(unitedSquareArea.topLeft,{longitude: point.longitude, latitude: unitedSquareArea.topLeft.latitude});
	const y = equirectangularDistance(unitedSquareArea.topLeft,{longitude: unitedSquareArea.topLeft.longitude, latitude: point.latitude});
	selfLocalCollisionArea.push([x,y]);
});
AIS[vesselID].collisionArea.forEach(point=>{
	const x = equirectangularDistance(unitedSquareArea.topLeft,{longitude: point.longitude, latitude: unitedSquareArea.topLeft.latitude});
	const y = equirectangularDistance(unitedSquareArea.topLeft,{longitude: unitedSquareArea.topLeft.longitude, latitude: point.latitude});
	targetLocalCollisionArea.push([x,y]);
});
//app.debug('targetLocalCollisionArea:',targetLocalCollisionArea);

// Определим, пересекаются ли какие-либо отрезки фигур collisionArea
// на самих и цели
//app.debug('\nchkCollision, selfLocalCollisionArea.length',selfLocalCollisionArea.length,'targetLocalCollisionArea.length',targetLocalCollisionArea.length);
let isIntersection = false;
let i,j,nextI,nextJ;	// они используются потом для отладки
const lenI = selfLocalCollisionArea.length, lenJ = targetLocalCollisionArea.length;
doIntersection: {
	for(i=0; i<lenI; i++){	// для каждого отрезка своей области нахождения
		nextI = i+1;
		if(nextI==lenI) nextI = 0;
		for(j=0; j<lenJ; j++){	// узнаем, пересекается ли он с каждым отрезком области другого судна
			nextJ = j+1;
			if(nextJ==lenJ) nextJ = 0;
			if(segmentIntersection(selfLocalCollisionArea[i],selfLocalCollisionArea[nextI],targetLocalCollisionArea[j],targetLocalCollisionArea[nextJ])){	// две точки первого отрезка, две точки второго отрезка
				isIntersection = true;
				break doIntersection;
			}
		}
	}
}

/*////////////////////////// collisionDetector test ///////////////////////////////
if(isIntersection){
	if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
	if(!collisionSegments[vesselID].segments) collisionSegments[vesselID].segments = [];
	collisionSegments[vesselID].segments.push([
		[AIS[selfContext].collisionArea[i],AIS[selfContext].collisionArea[nextI]],
		[AIS[vesselID].collisionArea[j],AIS[vesselID].collisionArea[nextJ]]
	]);
}
/*////////////////////////// end collisionDetector test ///////////////////////////////

// Возможно, вся область вероятного нахождения цели лежит внутри области
// нашего вероятного нахождения?
// Теперь используем isPointInPolygon для поддержки как треугольников, так и ромбов
if(!isIntersection){
	inside: {
		for(let point of targetLocalCollisionArea){	// для каждой точки области цели
			if(!isPointInPolygon(selfLocalCollisionArea, point)){	// точка вне нашего полигона
				break inside;
			};
		};
		isIntersection = true;	// все точки лежат внутри полигона
		/*////////////////////////// collisionDetector test ///////////////////////////////
		if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
		if(!collisionSegments[vesselID].segments) collisionSegments[vesselID].segments = [];
		collisionSegments[vesselID].segments.push([
			[AIS[vesselID].collisionArea[0],AIS[vesselID].collisionArea[1]],
			[AIS[vesselID].collisionArea[2],AIS[vesselID].collisionArea[0]]
		]);
		/*////////////////////////// end collisionDetector test ///////////////////////////////
	}
};
// Возможно, вся область нашего вероятного нахождения лежит внутри области
// вероятного нахождения цели?
// Теперь используем isPointInPolygon для поддержки как треугольников, так и ромбов
if(!isIntersection){
	inside: {
		for(let point of selfLocalCollisionArea){	// для каждой точки нашей области
			if(!isPointInPolygon(targetLocalCollisionArea, point)){	// точка вне полигона цели
				break inside;
			};
		};
		isIntersection = true;	// все точки лежат внутри полигона
	}
	/*////////////////////////// collisionDetector test ///////////////////////////////
	if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
	if(!collisionSegments[vesselID].segments) collisionSegments[vesselID].segments = [];
	collisionSegments[vesselID].segments.push([
		[AIS[selfContext].collisionArea[0],AIS[selfContext].collisionArea[1]],
		[AIS[selfContext].collisionArea[2],AIS[selfContext].collisionArea[0]]
	]);
	/*////////////////////////// end collisionDetector test ///////////////////////////////
};

if(!isIntersection) return false;	// ни одна пара отрезков внутри объединённой области не пересекается

// Пересечение принятых областей равной вероятности нахождения судов имеется
// Build enhanced collision data
const collisionData = {
	"lon": AIS[vesselID].position.longitude,
	"lat": AIS[vesselID].position.latitude,
	"bearing": bearing(AIS[selfContext].position, AIS[vesselID].position),
	"dist": smartDistance(AIS[selfContext].position, AIS[vesselID].position)
};

// Add CPA/TCPA data if available
if(cpaData) {
	collisionData.cpa = Math.round(cpaData.cpaDistance); // meters
	collisionData.tcpa = Math.round(cpaData.tcpa * 10) / 10; // minutes, 1 decimal
	collisionData.relativeSpeed = Math.round(cpaData.relativeSpeed * 10) / 10; // m/s, 1 decimal
}

// Add target vessel information
if(AIS[vesselID].course !== undefined) {
	collisionData.targetCourse = Math.round(AIS[vesselID].course * 180 / Math.PI); // degrees
}
if(AIS[vesselID].speed !== undefined) {
	collisionData.targetSpeed = Math.round(AIS[vesselID].speed * 10) / 10; // m/s, 1 decimal
}

collisions[vesselID] = collisionData;

return true; 
} // end function chkCollision

function collisionAlarm(status=false){
if(status) {
	app.handleMessage(plugin.id, {
		context: 'vessels.self',
		updates: [
			{
				values: [
					{
						"path": "notifications.danger.collision",
						"value": {
							"method": ["visual","sound"],
							"state": "alarm",
							"message": "Collision danger!",
							"source": plugin.id,
							"vessels": collisions,
							/*////////////////////////// end collisionDetector test ///////////////////////////////
							"collisionSegments": collisionSegments
							/*////////////////////////// collisionDetector test ///////////////////////////////
						},
					}
				],
				source: { label: plugin.id },
				timestamp: new Date().toISOString(),
			}
		]
	});
}
else {
	app.handleMessage(plugin.id, {
		context: 'vessels.self',
		updates: [
			{
				values: [
					{
						"path": "notifications.danger.collision",
						"value": null
					}
				],
				source: { label: plugin.id },
				timestamp: new Date().toISOString(),
			}
		]
	});
}
}; // end function collisionAlarm



function destinationPoint(from,distance,bearing){
// http://www.movable-type.co.uk/scripts/latlong.html
// from: {longitude: xx, latitude: xx} degrees
// distance: meters
// bearing: clockwise from north radians
const R = 6371e3;	// meters
const rad = Math.PI/180;
const deg = 180/Math.PI;
const φ1 = from.latitude * rad;
const λ1 = from.longitude * rad;
const δ = distance / R; // angular distance in radians
const φ2 = Math.asin( Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(bearing) );
const λ2 = λ1 + Math.atan2(Math.sin(bearing)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));
return {longitude: λ2*deg, latitude: φ2*deg};
} // end function destinationPoint

function equirectangularDistance(from,to){
// https://www.movable-type.co.uk/scripts/latlong.html
// from,to: {longitude: xx, latitude: xx}
const rad = Math.PI/180;
const φ1 = from.latitude * rad;
const φ2 = to.latitude * rad;
const Δλ = (to.longitude-from.longitude) * rad;
const R = 6371e3;	// метров
const x = Δλ * Math.cos((φ1+φ2)/2);
const y = (φ2-φ1);
const d = Math.sqrt(x*x + y*y) * R;	// метров
return d;
} // end function equirectangularDistance

function segmentIntersection(a1,a2,b1,b2){
// https://acmp.ru/article.asp?id_text=170
// Определяет пересечение отрезков A(ax1,ay1,ax2,ay2) и B (bx1,by1,bx2,by2),
// функция возвращает TRUE - если отрезки пересекаются, а если пересекаются 
// в концах или вовсе не пересекаются, возвращается FALSE (ложь)
let [ax1,ay1] = a1;
let [ax2,ay2] = a2;
let [bx1,by1] = b1;
let [bx2,by2] = b2;
let v1,v2,v3,v4;
v1=(bx2-bx1)*(ay1-by1)-(by2-by1)*(ax1-bx1);
v2=(bx2-bx1)*(ay2-by1)-(by2-by1)*(ax2-bx1);
v3=(ax2-ax1)*(by1-ay1)-(ay2-ay1)*(bx1-ax1);
v4=(ax2-ax1)*(by2-ay1)-(ay2-ay1)*(bx2-ax1);
return ((v1*v2)<0) && ((v3*v4)<0);
};

function isInTriangle_Vector(A, B, C, P){
// http://cyber-code.ru/tochka_v_treugolnike/
// Находится ли точка в треугольнике
// точки A [x,y], B,C -- треугольник
// P [x,y] -- проверяемая точка
let [aAx, aAy] = A;
let [aBx, aBy] = B;
let [aCx, aCy] = C;
let [aPx, aPy] = P;
let  Bx, By, Cx, Cy, Px, Py;
let  m, l; // мю и лямбда
// переносим треугольник точкой А в (0;0).
Bx = aBx - aAx; By = aBy - aAy;
Cx = aCx - aAx; Cy = aCy - aAy;
Px = aPx - aAx; Py = aPy - aAy;

m = (Px*By - Bx*Py) / (Cx*By - Bx*Cy);
if((m >= 0) && (m <= 1)){
	l = (Px - m*Cx) / Bx;
	return ((l >= 0) && ((m + l) <= 1));
};
return false;
}; // end function isInTriangle_Vector

function bearing(latlng1, latlng2) {
/* возвращает азимут c точки 1 на точку 2 */
//console.log(latlng1,latlng2)
const rad = Math.PI/180;
let lat1,lat2,lon1,lon2;
if(latlng1.lat) lat1 = latlng1.lat * rad;
else lat1 = latlng1.latitude * rad;
if(latlng2.lat) lat2 = latlng2.lat * rad;
else lat2 = latlng2.latitude * rad;
if(latlng1.lng) lon1 = latlng1.lng * rad;
else if(latlng1.lon) lon1 = latlng1.lon * rad;
else lon1 = latlng1.longitude * rad;
if(latlng2.lng) lon2 = latlng2.lng * rad;
else if(latlng2.lon) lon2 = latlng2.lon * rad;
else lon2 = latlng2.longitude * rad;
//console.log('lat1=',lat1,'lat2=',lat2,'lon1=',lon1,'lon2=',lon2)

let y = Math.sin(lon2 - lon1) * Math.cos(lat2);
let x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
//console.log('x',x,'y',y)

let bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
if(bearing >= 360) bearing = bearing-360;

return bearing;
} // end function bearing


}; // end plugin.start

/////////////
plugin.stop = function () {
unsubscribes.forEach(f => f());
unsubscribes = [];
}; // end plugin.stop

return plugin;
};


