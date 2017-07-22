'use strict'

const ApiAiApp = require('actions-on-google').ApiAiApp;
const functions = require('firebase-functions');
const https = require('https');

exports.tripBot = functions.https.onRequest((request, response) => {
	const app = new ApiAiApp({request: request, response: response});

	function airQuality (app) {
        getJSON('https://api.tfl.gov.uk/AirQuality', function (data) {
			let pollution = [lowerFirstChar(data.currentForecast[0].forecastBand),
							lowerFirstChar(data.currentForecast[1].forecastBand)]

			let speech = '';
			if(pollution[0] == "low" && pollution[1] == "low") {
				speech += randomFromArray(['Breathe easy! ', 'Good news! ', 'Hooray! '])
			} else if (pollution[0] == "low" && pollution[1] != "low") {
				speech += randomFromArray(['It\'s good now at least. ', 'There\'s good news and bad news. ']);
			} else if (pollution[0] == "high" || pollution[1] == "high") {
				speech += 'Oh dear...';
			}

			let connector = 'and';
			if(pollution[0] != pollution[1]) {
				connector = 'but';
			}

            speech += 'Currently pollution is ' + pollution[0] + ', ' + connector + ' is forecast to be ' + pollution[1] + '. ' + data.currentForecast[1].forecastSummary + '.';
            let destinationName = 'Londonair Forecast';
            let suggestionUrl = 'http://www.londonair.org.uk/LondonAir/Forecast/';

            askWithLink(speech, destinationName, suggestionUrl);
        })
	}

    function minicabLookup (app) {
        app.askForPermission("To find nearby licensed minicab operators",
        app.SupportedPermissions.DEVICE_PRECISE_LOCATION);
    }

    function minicabFind (app) {
        if (app.isPermissionGranted()) {
            let coordinates = app.getDeviceLocation().coordinates;

            getJSON('https://api.tfl.gov.uk/Cabwise/search?lat=' + coordinates.latitude + '&lon=' + coordinates.longitude + '&maxResults=5', function (data) {
                let options = [];

                data.Operators.OperatorList.forEach(function (operator) {
                    options.push({
                        title: operator.TradingName,
                        selectionKey: operator.BookingsPhoneNumber.replace(/\s/g,''),
                        synonyms: []
                    });
                })

                let speech = 'Which of these do you want to call?';
                let title = 'Licensed minicab operators';

                askWithList(speech, title, options);
            })
        } else {
            askSimpleResponse('Unfortunately I can\'t get you nearby minicab operators without your location 😞');
        }
    }

    function minicabCall (app) {
        askSimpleResponse("Their number is " + app.getSelectedOption() + ". Unfortuantely I can't call it for you yet - sorry! 😞");
    }

    function lineStatus (app) {
        let busLines = app.getArgument('bus-line')
        let undergroundLines = app.getArgument('underground-line');

        // If no arguments, check tube, dlr, tfl rail and overground by default
        if(busLines.length == 0 && undergroundLines.length == 0) {
            getJSON('https://api.tfl.gov.uk/Line/Mode/tube%2Cdlr%2Ctflrail%2Coverground/Status?detail=false', function (data) {
                let nonGoodServiceLines = [];

                // Go through each Line. If it is not running a good service (10),
                // add note to the nonGoodServiceLinesString
                let nonGoodServiceLinesString = '';
                data.forEach(function(line) {
                    if (line.lineStatuses[0].statusSeverity != 10) {
                        nonGoodServiceLinesString += line.lineStatuses[0].reason.split('.')[0] + '. ';
                    };
                })

                let speech = 'There is a good service operating on all London Underground lines.';

                if (nonGoodServiceLinesString != '') {
                    speech = nonGoodServiceLinesString + 'There is a good service operating on all other London Underground lines.';
                }

                let destinationName = 'TfL Status Updates'
                let suggestionUrl = 'https://tfl.gov.uk/tube-dlr-overground/status/'
                askWithLink(speech, destinationName, suggestionUrl);
            });
        } else {
            let url = 'https://api.tfl.gov.uk/Line/' + [undergroundLines,busLines].join() +'/Status?detail=false';
            console.log(url);

            getJSON(url, function (data) {
                // Sort lines into good and bad service
                let badServiceLines = [];
                let goodServiceLines = [];
                data.forEach(function (line) {
                    if(line.lineStatuses[0].statusSeverityDescription == 'Good Service') {
                        goodServiceLines.push({
                            name: line.name,
                            modeName: line.modeName
                        });
                    } else {
                        badServiceLines.push({
                            name: line.name,
                            modeName: line.modeName,
                            description: line.lineStatuses[0].statusSeverityDescription,
                            reason: (line.lineStatuses[0].reason.split('.')[0] + '. ' || null)
                        });
                    }
                });

                let speech = '';

                // Bad service lines
                badServiceLines.forEach(function (line) {
                    speech += line.reason;
                });

                // Good service lines
                speech += 'There is a good service operating on the '
                goodServiceLines = goodServiceLines.map(function (line) {
                    return line.name + ((line.modeName == 'tube') ? ' line' : (line.modeName == 'bus') ? ' bus' : '');
                });
                if(goodServiceLines.length > 1) {
                    speech += goodServiceLines.slice(0, -1).join(', ') + ' and ' + goodServiceLines[goodServiceLines.length - 1];
                } else {
                    speech += goodServiceLines[0];
                }

                // URL: use default, but if only one bus input link to that bus's page
                // If only multiple buses, link to the bus status page
                let destinationName = 'TfL Status Updates';
                let suggestionUrl = 'https://tfl.gov.uk/tube-dlr-overground/status/';
                if(undergroundLines.length == 0) {
                    if(busLines.length == 1) {
                        destinationName = 'TfL ' + busLines[0].toUpperCase() + ' Bus Status';
                        suggestionUrl = 'https://tfl.gov.uk/bus/status/?input=' + busLines[0];
                    } else {
                        destinationName = 'TfL Bus Updates';
                        suggestionUrl = 'https://tfl.gov.uk/bus/status/';
                    }
                }

                askWithLink(speech, destinationName, suggestionUrl);
            });
        }
    }

	const actionMap = new Map();
	actionMap.set('air_quality', airQuality);
	actionMap.set('minicab_lookup', minicabLookup);
	actionMap.set('minicab_find', minicabFind);
	actionMap.set('minicab_call', minicabCall);
	actionMap.set('line_status', lineStatus);
	app.handleRequest(actionMap);

    function askSimpleResponse(speech) {
        if (app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
            app.ask(app.buildRichResponse()
                .addSimpleResponse(speech)
            );
        } else {
            app.ask(speech);
        }
    }

    function askWithLink(speech, destinationName, suggestionUrl) {
        if (app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
            app.ask(app.buildRichResponse()
                .addSimpleResponse(speech)
                .addSuggestionLink(destinationName, suggestionUrl)
            );
        } else {
            app.ask(speech);
        }
    }

    function askWithList(speech, title, options) {
        let optionItems = [];
        options.forEach(function (option) {
            optionItems.push(app.buildOptionItem(option.selectionKey, option.synonyms).setTitle(option.title));
        });

        app.askWithList(speech,
            app.buildList(title)
             .addItems(optionItems));
    }
});

function getJSON(url, callback) {
    let req = https.get(url, function(res) {
        let data = '';

        res.on('data', function(chunk) {
            data += chunk;
        });

        res.on('end', function() {
            callback(JSON.parse(data));
        });
    });
}

function lowerFirstChar(str) {
    return str.charAt(0).toLowerCase() + str.slice(1);
}

function upperFirstChar(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function randomFromArray(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}
