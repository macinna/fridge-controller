

var fridgeController = angular.module('fridgeController', []);

var lastUpdateTicks = 0;

function mainController($scope, $timeout, $http) {
    $scope.formData = {};

    $scope.setPoint = 0;

    /*
    $http.get('/api/temperatures')
        .success(function(data) {
            $scope.temperatures = data;
        })
        .error(function(data) {
            console.log('Error: ' + data);
        });
    */


    (function updateLastUpdatedTime() {

        if(lastUpdateTicks > 0) {

            var lastUpdatedSeconds = Math.round(lastUpdateTicks / 1000);
            var currentSeconds = Math.round(Date.now() / 1000);

            $scope.lastUpdated = currentSeconds - lastUpdatedSeconds;

        }
        $timeout(updateLastUpdatedTime, 1000);
    })();



    (function updateTemperatures() {
        $http.get('api/temperatures').success(function (data) {
            $scope.temperatures = data;
            if($scope.setPoint == 0)
                $scope.setPoint = parseInt(data.desiredBeer);

            lastUpdateTicks = Date.now();

            $timeout(updateTemperatures, 15000);
        });
    })();


    $scope.saveConfiguration = function() {

        //validate input
        if($('#beerTempProbe').val() == $('#refrigeratorTempProbe').val()) {
            $('#validation-not-unique-error').toggleClass('show', true);
            $('#validation-not-unique-error').toggleClass('hidden', false);

            return;
        }

        var mapping = {
            beer: $('#beerTempProbe').val(),
            refrigerator: $('#refrigeratorTempProbe').val()
        }

        $http.put('/api/probes/', mapping)
            .success(function(data) {
                $('#config-save-success').toggleClass('show', true);
                $('#config-save-success').toggleClass('hidden', false);

            })
            .error(function(data) {
                console.log('Error: ' + data);
                $('#config-save-error').toggleClass('show', true);
                $('#config-save-error').toggleClass('hidden', false);

            });

    };

    $scope.getProbeInfo = function() {

        //remove any messages still lingering from previous time
        $('#config-save-success').toggleClass('show', false);
        $('#config-save-success').toggleClass('hidden', true);

        $('#config-save-error').toggleClass('show', false);
        $('#config-save-error').toggleClass('hidden', true);

        $('#validation-not-unique-error').toggleClass('show', false);
        $('#validation-not-unique-error').toggleClass('hidden', true);

        $http.get('/api/probes')
            .success(function(data) {
                //$scope.formData = {}; // clear the form so our user is ready to enter another

                var options = '<option value="">Select a Temperature Probe</option>';
                var selected = '';

                for(var i = 0; i < data.length; i++) {
                    if(data[i].usage == 'fridge') {
                        selected = ' selected ';
                    }

                    options += '<option value="{0}" {1}>{2}&nbsp;&nbsp;({3}°F)</option>'.format(
                        data[i].id,
                        selected,
                        data[i].id,
                        data[i].temperature);
                }
                $('#beerTempProbe').html(options);

                selected = '';
                options = '<option value="">Select a Temperature Probe</option>';
                for(var i = 0; i < data.length; i++) {
                    if(data[i].usage == 'ambient') {
                        selected = ' ambient ';
                    }
                    options += '<option value="{0}" {1}>{2}&nbsp;&nbsp;({3}°F)</option>'.format(
                        data[i].id,
                        selected,
                        data[i].id,
                        data[i].temperature);
                }
                $('#refrigeratorTempProbe').html(options);

            })
            .error(function(data) {
                console.log('Error: ' + data);
            });

    };

    var timeoutHandle = null;

    $scope.changeSetPoint = function(increment) {
        //we want to wait 5 seconds after the last change before sending the request to the server
        clearTimeout(timeoutHandle);
        $scope.setPoint += increment;
        timeoutHandle = setTimeout(function() {
            $http.put('/api/temperatures/' + $scope.setPoint)
                .success(function(data) {
                    console.log(data);
                })
                .error(function(data) {
                    console.log('Error: ' + data);
                });

        }, 5000);

    };

}





String.prototype.format = String.prototype.f = function() {
    var s = this,
        i = arguments.length;

    while (i--) {
        s = s.replace(new RegExp('\\{' + i + '\\}', 'gm'), arguments[i]);
    }
    return s;
};

function toCelcius(el, f) {
    el.title = Math.round((f - 32) * (5.0 / 9.0) * 10) / 10 + "°C";
}