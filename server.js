var express     = require('express');
var app         = express(); 								// create our app w/ express
var morgan      = require('morgan'); 			// log requests to the console (express4)
var bodyParser  = require('body-parser'); 	// pull information from HTML POST (express4)
var methodOverride = require('method-override'); // simulate DELETE and PUT (express4)
var tempHelper = require('./temperature-helper.js');
var pidController = require('./temp-control.js');
var winston = require('winston');

var Controller = require('./pid.js');

var nconf = require('nconf');

app.use(express.static(__dirname + '/public')); 				// set the static files location /public/img will be /img for users
app.use(morgan('dev')); 										// log every request to the console
app.use(bodyParser.urlencoded({'extended':'true'})); 			// parse application/x-www-form-urlencoded
app.use(bodyParser.json()); 									// parse application/json
app.use(bodyParser.json({ type: 'application/vnd.api+json' })); // parse application/vnd.api+json as json
app.use(methodOverride());
app.use(express.static(__dirname + '/public'));

nconf.use('file', {
    file: __dirname + '/config.json'
});
nconf.load();


// Configure the logger for data
winston.loggers.add('data', {
    file: {
        filename: __dirname + '/logs/data.log',
        json: false
    }
});

var dataLog = winston.loggers.get('data');

const DUTY_CYCLE = 1000;  //1 sec


// api ---------------------------------------------------------------------
// get temperatures
app.get('/api/temperatures', function(req, res) {

    //get fridge probe id
    var probeId = nconf.get('probes:beer');

    var beerTemp = '';
    if(probeId != undefined && probeId != '')
        beerTemp = tempHelper.getCurrentTemperature(probeId, tempHelper.unit.F);

    //get ambient temperature probe id
    probeId = nconf.get('probes:refrigerator');
    var fridgeTemp = '';
    if(probeId != undefined && probeId != '')
        fridgeTemp = tempHelper.getCurrentTemperature(probeId, tempHelper.unit.F);


    var temperatures = {
        beer: beerTemp,
        refrigerator: fridgeTemp,
        desiredBeer: nconf.get('desiredBeerTemp')
    };

    res.json(temperatures);
});


// change set point temperature
app.put('/api/temperatures/:set_point', function(req, res) {
    nconf.set('desiredBeerTemp', req.params.set_point);
    nconf.save( function (err) {
        if(err) {
            console.log('Error saving new temperature setting.');
        }
        else {
            res.json(req.params.set_point);
        }
    });
    regulateTemperature(req.params.set_point);

});



app.get('/api/probes', function(req, res) {

    var probes = tempHelper.getAllAttachedTempProbes();

    var beerProbeId = nconf.get('probes:beer');
    var refrigeratorProbeId = nconf.get('probes:refrigerator');

    var probeData = [];
    for(var i = 0; i < probes.length; i++) {
        var usage = '';
        if(probes[i] == beerProbeId)
            usage = 'beer';

        if(probes[i] == refrigeratorProbeId)
            usage = 'refrigerator';

        probeData.push({
            id: probes[i],
            temperature: tempHelper.getCurrentTemperature(probes[i], tempHelper.unit.F),
            usage: usage
        });

    }
    res.json(probeData);

});

app.put('/api/probes/', function(req, res) {

    nconf.set('probes:beer', req.body.beer);
    nconf.set('probes:refrigerator', req.body.refrigerator);

    nconf.save(function(err) {
        if(err) {
            console.log('Error saving probe mapping data to file.');
        }
        else {
            res.json(req.params.mapping);
        }

    });


});


// application -------------------------------------------------------------
app.get('*', function(req, res) {
    res.sendfile('./public/index.html'); // load the single view file (angular will handle the page changes on the front-end)
});

// listen (start app with node server.js) ======================================
var server = app.listen(process.argv[2] || 3030, function() {
    console.log('Listening on port %d', server.address().port);
});


//kick off the data logger. this runs independently from any other temperature jobs or regulator
setInterval( logTemperatures, 30000);

function logTemperatures() {

    //try {
        //get fridge probe id
        var probeId = nconf.get('probes:beer');

        var beerTemp = '';
        if (probeId != undefined && probeId != '')
            beerTemp = tempHelper.getCurrentTemperature(probeId, tempHelper.unit.F);

        //get ambient temperature probe id
        probeId = nconf.get('probes:refrigerator');
        var fridgeTemp = '';
        if (probeId != undefined && probeId != '')
            fridgeTemp = tempHelper.getCurrentTemperature(probeId, tempHelper.unit.F);

        dataLog.info(',%s,%s', beerTemp, fridgeTemp);
    //} catch(e) {
        //just going to swallow and ignore for now
    //}
}






// kick off the regulation of temp
var desiredTemp = nconf.get('desiredBeerTemp');
var temperatureIntervalHandle;

if(nconf.get('startOnLoad') === 'true' && desiredTemp && desiredTemp.trim().length > 0 && !isNaN(desiredTemp)) {
    regulateTemperature(desiredTemp);
}

function regulateTemperature(setPoint) {

    pidController.init(nconf.get('probes:beer'), nconf.get('probes:refrigerator'));
    pidController.setBeerTemp(tempHelper.convertToCentigrade(setPoint));
    pidController.setMode(pidController.modes.BEER_CONSTANT);
    if(temperatureIntervalHandle) {
        clearInterval(temperatureIntervalHandle);
    }

    temperatureIntervalHandle  = setInterval( function () {
        pidController.updateTemperatures();
        pidController.detectPeaks();
        pidController.updatePID();

        console.log(pidController.getState());

        pidController.updateState();
        pidController.updateOutputs();

    }, DUTY_CYCLE);

}




