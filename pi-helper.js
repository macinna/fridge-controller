var wpi = require('wiring-pi');

wpi.wiringPiSetupSys();

const ON = 1;
const OFF = 0;

const COOLING_PIN = 17;  //physical pin 11
const HEATING_PIN = 18;   //physical pin 12

var currentState = 'off';


module.exports = {
    setState: function (state) {

        if(state == 'heat') {
            wpi.digitalWrite(HEATING_PIN, ON);
            wpi.digitalWrite(COOLING_PIN, OFF);
        }

        if(state == 'cool') {
            wpi.digitalWrite(COOLING_PIN, ON);
            wpi.digitalWrite(HEATING_PIN, OFF);
        }

        if(state == 'off') {
            wpi.digitalWrite(COOLING_PIN, OFF);
            wpi.digitalWrite(HEATING_PIN, OFF);
        }
        currentState = state;
    },
    getState: function () {
        return currentState;
    }
}