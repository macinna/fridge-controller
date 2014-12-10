var fs = require('fs');
var attachedTemperatureProbes = [];

module.exports = {
    getAllAttachedTempProbes: function() {

        if(attachedTemperatureProbes.length > 0)
            return attachedTemperatureProbes;


        //The 1wire file system (owfs) used by this system creates directories for each attached supported probe types.
        //The temperature probes this system supports are the 18S20 and 18B20.  These have a
        //1wire family type ID of 10 and 28 respectively (see http://owfs.sourceforge.net/family.html).
        //The directory names are prefixed with that ID, so we're going to search our 1wire directory
        //for subdirectories with names that start with 10. or 28.

        var files = fs.readdirSync('/mnt/1wire/');
        for( var i = 0; i < files.length; i++ ) {
            var family = files[i].split('.')[0];
            if( family === '10' || family === '28' ){
                attachedTemperatureProbes.push(files[i]);
            }
        }

        return attachedTemperatureProbes;
    },
    getCurrentTemperature: function(probeId, units) {

        units = units || this.unit.F;

        var temperatureFile = '/mnt/1wire/' + probeId + '/temperature10';
        var degC = parseFloat(fs.readFileSync(temperatureFile, 'utf8'));

        if(units === this.unit.C)
            return degC;

        return this.convertToFahrenheit(degC);
    },
    unit: Object.freeze({
        F: 'f',
        C: 'c'
    }),
    convertToCentigrade: function (fahrenheit) {
        var degC = (fahrenheit - 32) * (5.0/9.0);
        degC = Math.round(degC * 10) / 10;
        return degC;
    },
    convertToFahrenheit: function (centigrade) {
        var degF = centigrade * (9.0/5.0) + 32;
        degF = Math.round(degF * 10) / 10;
        return degF;
    }

};