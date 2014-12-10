
var piHelper = require('./pi-helper.js');
var tempHelper = require('./temperature-helper.js');

const   MIN_COOL_OFF_TIME                   = 300,  // Set minimum off time to prevent short cycling the compressor in seconds
        MIN_HEAT_OFF_TIME                   = 300,  // Use a minimum off time for the heater as well, so it heats in cycles, not lots of short bursts
        MIN_COOL_ON_TIME                    = 180,  // Minimum on time for the cooler.
        MIN_HEAT_ON_TIME                    = 180,  // Minimum on time for the heater.
        MIN_COOL_OFF_TIME_FRIDGE_CONSTANT   = 600,  // Use a large minimum off time in fridge constant mode. No need for very fast cycling.
        MIN_SWITCH_TIME                     = 600,  // Set a minimum off time between switching between heating and cooling
        COOL_PEAK_DETECT_TIME               = 1800, // Time allowed for peak detection
        HEAT_PEAK_DETECT_TIME               = 900;

const   INVALID_TEMP    = -10000,
        MIN_TEMP        = INVALID_TEMP + 1,
        MAX_TEMP        = 10000;

const   INFO_POSITIVE_PEAK    = 'info-pos-peak',
        INFO_NEGATIVE_PEAK    = 'info-neg-peak',
        INFO_POSITIVE_DRIFT   = 'info-pos-drift',
        INFO_NEGATIVE_DRIFT   = 'info-neg-drift';


//states
var states = {
    IDLE: 'idle',
    STATE_OFF: 'off',
    DOOR_OPEN: 'door-open',
    HEATING: 'heating',
    COOLING: 'cooling',
    WAITING_TO_COOL: 'waiting-to-cool',
    WAITING_TO_HEAT: 'waiting-to-heat',
    WAITING_FOR_PEAK_DETECT: 'waiting-for-peak-detect',
    COOLING_MIN_TIME: 'cooling-min-time',
    HEATING_MIN_TIME: 'heating-min-time',
    NUM_STATES: 'num-states'
};

var modes = {
        OFF: 'off',
        FRIDGE_CONSTANT: 'fridge-constant',
        BEER_CONSTANT: 'beer-constant',
        BEER_PROFILE: 'beer-profile',
        TEST: 'test'
};

var cs = {
    mode: modes.OFF,
    beerSetting: 20,
    fridgeSetting: 20,
    heatEstimator: 0.2,
    coolEstimator: 5
};


var cc = {
    tempFormat: 'C',
    tempSettingMin : 1,
    tempSettingMax: 30,
    Kp: 5,
    Ki: 0.25,
    Kd: -1.5,
    iMaxError: 0.5,
    idleRangeHigh: 1,
    idleRangeLow: -1,
    heatingTargetUpper: 0.3,
    heatingTargetLower: -0.2,
    coolingTargetUpper: 0.2,
    coolingTargetLower: -0.3,
    maxHeatTimeForEstimate: 600,
    maxCoolTimeForEstimate: 1200,
    pidMax: 10,
    lightAsHeater: true
};

var cv = {
    posPeakEstimate: 0,
    negPeakEstimate: 0,
    p: 0,
    i: 0,
    d: 0,
    posPeak: 0,
    negPeak: 0,
    diffIntegral: 0,
    beerSlope: 0

};



var lastHeatTime,
    lastCoolTime,
    lastIdleTime,
    doPosPeakDetect,
    doNegPeakDetect,
    state,
    waitTime,
    integralUpdateCounter = 0,
    sampleCountBeforeCalculatingSlope = 300,  //number of seconds to wait before calculating slope after initial start
    beerProbeId = '',
    fridgeProbeId = '';



//arrays that will be treated like stacks to hold temperature history
var fridgeTempHistory = [],
    beerTempHistory = [];


module.exports = {
    modes: modes,
    init: function (beerProbe, fridgeProbe) {
        state = states.IDLE;
        cs.mode = modes.OFF;
        beerProbeId = beerProbe;
        fridgeProbeId = fridgeProbe;

        // this is for cases where the device manager hasn't configured beer/fridge sensor.
        /*
         if (beerSensor==NULL) {
         beerSensor = new TempSensor(TEMP_SENSOR_TYPE_BEER, &defaultTempSensor);
         beerSensor->init();
         }

         if (fridgeSensor==NULL) {
         fridgeSensor = new TempSensor(TEMP_SENSOR_TYPE_FRIDGE, &defaultTempSensor);
         fridgeSensor->init();
         }
         */

        this.updateTemperatures();
        reset();

        // Do not allow heating/cooling directly after reset.
        // A failing script + CRON + Arduino uno (which resets on serial connect) could damage the compressor
        // For test purposes, set these to -3600 to eliminate waiting after reset
        lastHeatTime = 0;
        lastCoolTime = 0;
    },
    getState: function () {
        return state;
    },
    updateTemperatures: function () {

        if (beerTempHistory.length < 10) {
            beerTempHistory.push(getBeerTemperature());
        } else {
            beerTempHistory.shift();
            beerTempHistory.push(getBeerTemperature());
        }

        if (fridgeTempHistory.length < 10) {
            fridgeTempHistory.push(getFridgeTemperature());
        } else {
            fridgeTempHistory.shift();
            fridgeTempHistory.push(getFridgeTemperature());
        }

        // updateSensor(beerSensor);
        // updateSensor(fridgeSensor);

    },
    updatePID: function () {

        if (modeIsBeer()) {

            /*

             if(cs.beerSetting == INVALID_TEMP){
             // beer setting is not updated yet
             // set fridge to unknown too
             cs.fridgeSetting = INVALID_TEMP;
             return;
             }
             */

            // fridge setting is calculated with PID algorithm. Beer temperature error is input to PID
            cv.beerDiff = cs.beerSetting - getBeerTemperature();
            cv.beerSlope = getBeerSlope();
            var fridgeTemp = getFridgeTemperature();

            console.log('integralUpdateCounter: ' + integralUpdateCounter);
            if (integralUpdateCounter++ == 60) {
                integralUpdateCounter = 0;

                var integratorUpdate = cv.beerDiff;

                // Only update integrator in IDLE, because that's when the fridge temp has reached the fridge setting.
                // If the beer temp is still not correct, the fridge setting is too low/high and integrator action is needed.
                if (state != states.IDLE) {
                    integratorUpdate = 0;
                }
                else if (Math.abs(integratorUpdate) < cc.iMaxError) {
                    // difference is smaller than iMaxError
                    // check additional conditions to see if integrator should be active to prevent windup
                    var updateSign = (integratorUpdate > 0); // 1 = positive, 0 = negative
                    var integratorSign = (cv.diffIntegral > 0);

                    if (updateSign == integratorSign) {
                        // beerDiff and integrator have same sign. Integrator would be increased.

                        // If actuator is already at max increasing actuator will only cause integrator windup.
                        integratorUpdate = (cs.fridgeSetting >= cc.tempSettingMax) ? 0 : integratorUpdate;
                        integratorUpdate = (cs.fridgeSetting <= cc.tempSettingMin) ? 0 : integratorUpdate;
                        integratorUpdate = ((cs.fridgeSetting - cs.beerSetting) >= cc.pidMax) ? 0 : integratorUpdate;
                        integratorUpdate = ((cs.beerSetting - cs.fridgeSetting) >= cc.pidMax) ? 0 : integratorUpdate;

                        // cooling and fridge temp is more than 2 degrees from setting, actuator is saturated.
                        integratorUpdate = (!updateSign && (fridgeTemp > (cs.fridgeSetting + 2))) ? 0 : integratorUpdate;

                        // heating and fridge temp is more than 2 degrees from setting, actuator is saturated.
                        integratorUpdate = (updateSign && (fridgeTemp < (cs.fridgeSetting - 2))) ? 0 : integratorUpdate;
                    }
                    else {
                        // integrator action is decreased. Decrease faster than increase.
                        integratorUpdate = integratorUpdate * 2;
                    }
                }
                else {
                    // decrease integral by 1/8 when far from the end value to reset the integrator
                    integratorUpdate = -(cv.diffIntegral / 8.0);
                }
                cv.diffIntegral = cv.diffIntegral + integratorUpdate;
            }

            // calculate PID parts. Use long_temperature to prevent overflow
            cv.p = constrainTemp(cc.Kp * cv.beerDiff, MIN_TEMP, MAX_TEMP);
            cv.i = constrainTemp(cc.Ki * cv.diffIntegral, MIN_TEMP, MAX_TEMP);
            cv.d = constrainTemp(cc.Kd * cv.beerSlope, MIN_TEMP, MAX_TEMP);
            var newFridgeSetting = cs.beerSetting;
            newFridgeSetting += cv.p;
            newFridgeSetting += cv.i;
            newFridgeSetting += cv.d;

            // constrain to tempSettingMin or beerSetting - pidMAx, whichever is lower.
            var lowerBound = (cs.beerSetting <= cc.tempSettingMin + cc.pidMax) ? cc.tempSettingMin : cs.beerSetting - cc.pidMax;
            // constrain to tempSettingMax or beerSetting + pidMAx, whichever is higher.
            var upperBound = (cs.beerSetting >= cc.tempSettingMax - cc.pidMax) ? cc.tempSettingMax : cs.beerSetting + cc.pidMax;

            cs.fridgeSetting = constrainTemp(newFridgeSetting, lowerBound, upperBound);

            console.log('cs: ' + JSON.stringify(cs));

        }
        else if (cs.mode == modes.FRIDGE_CONSTANT) {
            // FridgeTemperature is set manually, use INVALID_TEMP to indicate beer temp is not active
            cs.beerSetting = INVALID_TEMP;
        }



    },


    updateState: function () {
        //update state
        var stayIdle = false;

        if (cs.mode == modes.OFF) {
            state = states.STATE_OFF;
            stayIdle = true;
        }

        // stay idle when one of the required sensors is disconnected, or the fridge setting is INVALID_TEMP
        /*
         if( cs.fridgeSetting == INVALID_TEMP ||
         !fridgeSensor->isConnected() ||
         (!beerSensor->isConnected() && tempControl.modeIsBeer())){
         state = IDLE;
         stayIdle = true;
         }
         */

        var sinceIdle = timeSinceIdle();
        var sinceCooling = timeSinceCooling();
        var sinceHeating = timeSinceHeating();
        var fridgeTemp = getFridgeTemperature();
        var beerTemp = getBeerTemperature();

        var secs = Date.now() / 1000; //convert to seconds
        switch (state) {
            case states.IDLE:
            case states.STATE_OFF:
            case states.WAITING_TO_COOL:
            case states.WAITING_TO_HEAT:
            case states.WAITING_FOR_PEAK_DETECT:
            {
                lastIdleTime = secs;
                // set waitTime to zero. It will be set to the maximum required waitTime below when wait is in effect.
                if (stayIdle) {
                    break;
                }
                waitTime = 0;
                if (fridgeTemp > (cs.fridgeSetting + cc.idleRangeHigh)) {  // fridge temperature is too high
                    updateWaitTime(MIN_SWITCH_TIME, sinceHeating);
                    if (cs.mode === modes.FRIDGE_CONSTANT) {
                        updateWaitTime(MIN_COOL_OFF_TIME_FRIDGE_CONSTANT, sinceCooling);
                    }
                    else {
                        if (beerTemp < cs.beerSetting + 0.5) { // If beer is in idle zone, stay/go to idle. 1 degree total idle zone
                            state = states.IDLE; // beer is already colder than setting, stay in or go to idle
                            break;
                        }
                        updateWaitTime(MIN_COOL_OFF_TIME, sinceCooling);
                    }
                    if (waitTime > 0) {
                        state = states.WAITING_TO_COOL;
                    }
                    else {
                        state = states.COOLING;
                    }
                }
                else if (fridgeTemp < (cs.fridgeSetting + cc.idleRangeLow)) {  // fridge temperature is too low
                    updateWaitTime(MIN_SWITCH_TIME, sinceCooling);
                    updateWaitTime(MIN_HEAT_OFF_TIME, sinceHeating);
                    if (cs.mode != modes.FRIDGE_CONSTANT) {
                        if (beerTemp > (cs.beerSetting - 0.5)) { // If beer is already over target, stay/go to idle. 1/2 sensor bit idle zone
                            state = states.IDLE;  // beer is already warmer than setting, stay in or go to idle
                            break;
                        }
                    }
                    if (waitTime > 0) {
                        state = states.WAITING_TO_HEAT;
                    }
                    else {
                        state = states.HEATING;
                    }
                }
                else {
                    state = states.IDLE; // within IDLE range, always go to IDLE
                    break;
                }
                if (state == states.HEATING || state == states.COOLING) {
                    if (doNegPeakDetect == true || doPosPeakDetect == true) {
                        // If peak detect is not finished, but the fridge wants to switch to heat/cool
                        // Wait for peak detection and display 'Await peak detect' on display
                        state = states.WAITING_FOR_PEAK_DETECT;
                        break;
                    }
                }
            }
                break;
            case states.COOLING:
            case states.COOLING_MIN_TIME:
            {
                doNegPeakDetect = true;
                lastCoolTime = secs;
                updateEstimatedPeak(cc.maxCoolTimeForEstimate, cs.coolEstimator, sinceIdle);
                state = states.COOLING; // set to cooling here, so the display of COOLING/COOLING_MIN_TIME is correct

                // stop cooling when estimated fridge temp peak lands on target or if beer is already too cold (1/2 sensor bit idle zone)
                if (cv.estimatedPeak <= cs.fridgeSetting || (cs.mode != modes.FRIDGE_CONSTANT && beerTemp < (cs.beerSetting - 0.5))) {
                    if (sinceIdle > MIN_COOL_ON_TIME) {
                        cv.negPeakEstimate = cv.estimatedPeak; // remember estimated peak when I switch to IDLE, to adjust estimator later
                        state = states.IDLE;
                        break;
                    }
                    else {
                        state = states.COOLING_MIN_TIME;
                        break;
                    }
                }
            }
                break;
            case states.HEATING:
            case states.HEATING_MIN_TIME:
            {
                doPosPeakDetect = true;
                lastHeatTime = secs;
                updateEstimatedPeak(cc.maxHeatTimeForEstimate, cs.heatEstimator, sinceIdle);
                state = states.HEATING; // reset to heating here, so the display of HEATING/HEATING_MIN_TIME is correct

                // stop heating when estimated fridge temp peak lands on target or if beer is already too warm (1/2 sensor bit idle zone)
                if (cv.estimatedPeak >= cs.fridgeSetting || (cs.mode != modes.FRIDGE_CONSTANT && beerTemp > (cs.beerSetting + 0.5))) {
                    if (sinceIdle > MIN_HEAT_ON_TIME) {
                        cv.posPeakEstimate = cv.estimatedPeak; // remember estimated peak when I switch to IDLE, to adjust estimator later
                        state = states.IDLE;
                        break;
                    }
                    else {
                        state = states.HEATING_MIN_TIME;
                        break;
                    }
                }
            }
                break;
        }
    },
    updateOutputs: function () {
        if (cs.mode == modes.TEST)
            return;

        if (stateIsHeating()) {
            piHelper.setState('heat');
        } else if (stateIsCooling()) {
            piHelper.setState('cool');
        } else {
            piHelper.setState('off');
        }

        /*
         cooler->setActive(cooling);
         heater->setActive(!cc.lightAsHeater && heating);
         light->setActive(isDoorOpen() || (cc.lightAsHeater && heating) || cameraLightState.isActive());
         fan->setActive(heating || cooling);
         */
    },
    detectPeaks: function () {
        //detect peaks in fridge temperature to tune overshoot estimators
        var detected = 0,
            peak,
            estimate,
            error,
            oldEstimator,
            newEstimator;

        if (doPosPeakDetect && !stateIsHeating()) {
            peak = detectPosPeak();
            estimate = cv.posPeakEstimate;
            error = peak - estimate;
            oldEstimator = cs.heatEstimator;
            if (peak != INVALID_TEMP) {
                // positive peak detected
                if (error > cc.heatingTargetUpper) {
                    // Peak temperature was higher than the estimate.
                    // Overshoot was higher than expected
                    // Increase estimator to increase the estimated overshoot
                    cs.heatEstimator = increaseEstimator(cs.heatEstimator, error);
                }
                if (error < cc.heatingTargetLower) {
                    // Peak temperature was lower than the estimate.
                    // Overshoot was lower than expected
                    // Decrease estimator to decrease the estimated overshoot
                    cs.heatEstimator = decreaseEstimator(cs.heatEstimator, error);
                }
                detected = INFO_POSITIVE_PEAK;
            } else if (timeSinceHeating() > HEAT_PEAK_DETECT_TIME) {
                if (getFridgeTemperature() < (cv.posPeakEstimate + cc.heatingTargetLower)) {
                    // Idle period almost reaches maximum allowed time for peak detection
                    // This is the heat, then drift up too slow (but in the right direction).
                    // estimator is too high
                    peak = getFridgeTemperature();
                    cs.heatEstimator = decreaseEstimator(cs.heatEstimator, error);
                    detected = INFO_POSITIVE_DRIFT;
                }
                else {
                    // maximum time for peak estimation reached
                    doPosPeakDetect = false;
                }
            }
            if (detected) {
                newEstimator = cs.heatEstimator;
                cv.posPeak = peak;
                doPosPeakDetect = false;
            }
        }
        else if (doNegPeakDetect && !stateIsCooling()) {
            peak = detectNegPeak();
            estimate = cv.negPeakEstimate;
            error = peak - estimate;
            oldEstimator = cs.coolEstimator;
            if (peak != INVALID_TEMP) {
                // negative peak detected
                if (error < cc.coolingTargetLower) {
                    // Peak temperature was lower than the estimate.
                    // Overshoot was higher than expected
                    // Increase estimator to increase the estimated overshoot
                    cs.coolEstimator = increaseEstimator(cs.coolEstimator, error);
                }
                if (error > cc.coolingTargetUpper) {
                    // Peak temperature was higher than the estimate.
                    // Overshoot was lower than expected
                    // Decrease estimator to decrease the estimated overshoot
                    cs.coolEstimator = decreaseEstimator(cs.coolEstimator, error);

                }
                detected = INFO_NEGATIVE_PEAK;
            }
            else if (timeSinceCooling() > COOL_PEAK_DETECT_TIME) {
                if (getFridgeTemperature() > (cv.negPeakEstimate + cc.coolingTargetUpper)) {
                    // Idle period almost reaches maximum allowed time for peak detection
                    // This is the cooling, then drift down too slow (but in the right direction).
                    // estimator is too high
                    peak = getFridgeTemperature();
                    cs.coolEstimator = decreaseEstimator(cs.coolEstimator, error);
                    detected = INFO_NEGATIVE_DRIFT;
                }
                else {
                    // maximum time for peak estimation reached
                    doNegPeakDetect = false;
                }
            }
            if (detected) {
                newEstimator = cs.coolEstimator;
                cv.negPeak = peak;
                doNegPeakDetect = false;
            }
        }
        if (detected) {
            // send out log message for type of peak detected
            //logInfoTempTempFixedFixed(detected, peak, estimate, oldEstimator, newEstimator);
        }
    },


    setMode: function (newMode, force) {
        if (newMode != cs.mode || state == states.WAITING_TO_HEAT || state == states.WAITING_TO_COOL || state == states.WAITING_FOR_PEAK_DETECT) {
            state = states.IDLE;
            force = true;
        }
        if (force) {
            cs.mode = newMode;
            if (newMode == modes.OFF) {
                cs.beerSetting = INVALID_TEMP;
                cs.fridgeSetting = INVALID_TEMP;
            }
            //eepromManager.storeTempSettings();
        }
    },
    getBeerSetting: function () {
        return cs.beerSetting;
    },


    getFridgeSetting: function () {
        return cs.fridgeSetting;
    },


    setBeerTemp: function (newTemp) {
        var oldBeerSetting = cs.beerSetting;
        newTemp = parseFloat(newTemp);
        cs.beerSetting = newTemp;
        if (Math.abs(oldBeerSetting - newTemp) > 0.5) { // more than half degree C difference with old setting
            reset(); // reset controller
        }
        this.updatePID();
        this.updateState();
    },
    setFridgeTemp: function (newTemp) {
        cs.fridgeSetting = newTemp;
        reset(); // reset peak detection and PID
        this.updatePID();
        this.updateState();
        //eepromManager.storeTempSettings();
    }
};

function reset(){
    doPosPeakDetect = false;
    doNegPeakDetect = false;
}

function getBeerTemperature() {
    return tempHelper.getCurrentTemperature(beerProbeId, tempHelper.unit.C);
}

function getFridgeTemperature() {
    return tempHelper.getCurrentTemperature(fridgeProbeId, tempHelper.unit.C);
}

function getBeerSlope() {
    //beer slope is the slope every 3 samples

    if (sampleCountBeforeCalculatingSlope > 0) {
        sampleCountBeforeCalculatingSlope--;
        return 0;
    }

    //if we get to this point, then we've gotten past the initial stabilization period and are ready to start calculating slope
    return beerTempHistory[beerTempHistory.length - 1] - beerTempHistory[beerTempHistory.length - 4];
}

function modeIsBeer() {
    return (cs.mode == modes.BEER_CONSTANT || cs.mode == modes.BEER_PROFILE);
}

function updateWaitTime(newTimeLimit, newTimeSince) {
    if(newTimeSince < newTimeLimit){
        var newWaitTime = newTimeLimit - newTimeSince;
        if(newWaitTime > waitTime){
            waitTime = newWaitTime;
        }
    }
}
function updateEstimatedPeak(timeLimit, estimator, sinceIdle)
{
    var activeTime = min(timeLimit, sinceIdle); // heat or cool time in seconds
    var estimatedOvershoot = (estimator * activeTime) / 3600; // overshoot estimator is in overshoot per hour
    if(stateIsCooling()){
        estimatedOvershoot = -estimatedOvershoot; // when cooling subtract overshoot from fridge temperature
    }
    cv.estimatedPeak = getFridgeTemperature() + estimatedOvershoot;
}



function detectPosPeak() {
    var recordCount = beerTempHistory.length;

    if(beerTempHistory[recordCount - 2] >=  beerTempHistory[recordCount - 3] && beerTempHistory[recordCount - 2] > beerTempHistory[recordCount - 1]) {
        return beerTempHistory[recordCount - 2];
    } else {
        return INVALID_TEMP;
    }


}

function detectNegPeak() {
    var recordCount = beerTempHistory.length;

    if(beerTempHistory[recordCount - 2] <=  beerTempHistory[recordCount - 3] && beerTempHistory[recordCount - 2] < beerTempHistory[recordCount - 1]) {
        return beerTempHistory[recordCount - 2];
    } else {
        return INVALID_TEMP;
    }

}



// Increase estimator at least 20%, max 50%s
function increaseEstimator(currentEstimate, error){

    var factor = constrainTemp(1.2 + error * 0.031, 1.2, 1.5); // 1.2 + 3.1% of error, limit between 1.2 and 1.5
    var newEstimate = currentEstimate * factor;

    if(newEstimate < 0.05)
        newEstimate = 0.05;

    return newEstimate;

    /*

    var factor = 614 + constrainTemp(Math.abs(error)>>5, 0, 154); // 1.2 + 3.1% of error, limit between 1.2 and 1.5
    *estimator = multiplyFactorTemperatureDiff(factor, *estimator);
    if(*estimator < 25){
    *estimator = intToTempDiff(5)/100; // make estimator at least 0.05
    }
    eepromManager.storeTempSettings();
    */
}

// Decrease estimator at least 16.7% (1/1.2), max 33.3% (1/1.5)
function decreaseEstimator(currentEstimate, error){

    var factor = constrainTemp(0.833 - error * 0.031, 0.667, 0.833); // 0.833 - 3.1% of error, limit between 0.667 and 0.833
    return currentEstimate * factor;


    /*
    temperature factor = 426 - constrainTemp(abs(error)>>5, 0, 85); // 0.833 - 3.1% of error, limit between 0.667 and 0.833
*estimator = multiplyFactorTemperatureDiff(factor, *estimator);
    eepromManager.storeTempSettings();
    */
}

function timeSinceCooling(){
    return Date.now() - lastCoolTime;
}

function timeSinceHeating() {
    return Date.now() - lastHeatTime;
}

function timeSinceIdle() {
    return Date.now() - lastIdleTime;
}

function stateIsCooling() {
    return (state === states.COOLING || state === states.COOLING_MIN_TIME);
}
function stateIsHeating() {
    return (state === states.HEATING || state === states.HEATING_MIN_TIME);
}


function constrainTemp(val, lower, upper){

    if(val < lower){
        return lower;
    }

    if(val > upper){
        return upper;
    }
    return val;
}


function min(a, b) {
    return a < b ? a : b;
}









