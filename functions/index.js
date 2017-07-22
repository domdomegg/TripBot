'use strict'

const ApiAiApp = require('actions-on-google').ApiAiApp;
const functions = require('firebase-functions');
const https = require('https');

const MAX_BUS_ARRIVALS_RETURNED_NO_SCREEN = 5;
// 15 line limit in basic card
const MAX_BUS_ARRIVALS_RETURNED_SCREEN = 15;

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

	function busArrivals(app) {
		let busLine = app.getArgument('bus-line')
        let busStopSms = app.getArgument('bus-stop-sms');
        let busStopAddress = app.getArgument('bus-stop-address');

		// Check we know where we are (or at least think we do)
		if(busStopSms || busStopAddress) {
			let url = 'https://api.tfl.gov.uk/StopPoint/Search/' + (busStopSms ? busStopSms : busStopAddress) + '?modes=bus';

			getJSON(url, function (stop_data) {
				if(busStopSms) {
					if(busStopSms == "87287") {
						askWithImage(randomFromArray([
							'Sorry, I need the other 5 digit number on that sign for bus arrivals (the one on the white background).',
							'I need the other 5 digit number - on the white background.'
						]), 'Bus stop code example', 'https://upload.wikimedia.org/wikipedia/commons/d/dc/Quex_Road_%28Stop_N%29_Countdown_SMS_Code.jpg');
					}

					if (stop_data.total == 0) {
						// Couldn't find it
						let speech = randomFromArray(['Sorry - I couldn\'t find that stop. Are you sure the SMS code is correct?',
													'Hmmm - I couldn\'t find that one. Can you repeat the SMS code?']);
						askSimpleResponse(speech);
					} else if (stop_data.total > 1) {
						// Show list of bus stops

					} else if (stop_data.total == 1) {
						// Get arrival predictions
						url = 'https://api.tfl.gov.uk/StopPoint/' + stop_data.matches[0].id + '/Arrivals';
						getJSON(url, processArrivalsData);
					}
				} else {
					// Present list of stops

					// Get list of Naptan IDs
					let stop_pairs = [];
					let options = [];
					stop_data.matches.forEach(function (stop_pair) {
						stop_pairs.push(stop_pair.id);
					});

					// Get individual stops data
					url = 'https://api.tfl.gov.uk/StopPoint/' + stop_pairs.join() + '?includeCrowdingData=false';
					getJSON(url, function (stops_data) {
						if(Array.isArray(stops_data)) {
							stops_data.forEach(function (stop_pair) {
								stop_pair.children.forEach(function (stop) {
									options.push({
										selectionKey: stop.id,
										title: (stop.commonName + (stop.stopLetter ? ' (' + stop.stopLetter + ')' : '')),
										synonyms: [stop.stopLetter, stop.indicator]
									});
								});
							});
						} else {
							stops_data.children.forEach(function (stop) {
								options.push({
									selectionKey: stop.id,
									title: (stop.commonName + ' (' + stop.stopLetter + ')'),
									synonyms: [stop.stopLetter, stop.indicator]
								});
							});
						};

						let speech = 'Which stop do you want arrivals information for?';
						let title = 'Bus stops';

						app.setContext('bus_arrivals_list_followup');
						askWithList(speech, title, options);
					});
				}
			});
		} else {
			// Prompt the user for a sms location code
			let speech = randomFromArray(['What\'s the name of your bus stop or its 5 digit bus stop code? It\'s on the bus stop pole, marked "For next bus information"',
										'What\'s the name of the bus stop or its bus stop code? The bus stop code is the 5-digit number on a sign at the bus stop.',
										'What\'s your bus stop\'s name it\'s bus stop code? It\'s the 5-digit number attached to the bus stop post.']);
			let imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/d/dc/Quex_Road_%28Stop_N%29_Countdown_SMS_Code.jpg';
			let imageDesc = 'Countdown SMS code example';

			askWithImage(speech, imageDesc, imageUrl);
		}
	}

	function processArrivalsData(arrivals_data) {
		if (app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
			let speech = 'Sure. Here are the next buses arriving at ' + arrivals_data[0].stationName;
			let title = 'Bus arrivals';
			let text = 'Unfortuantely live arrivals are not available at that stop at the moment.'

			if(arrivals_data.length != 0) {
				text = '';

				title = arrivals_data[0].stationName + (arrivals_data[0].platformName ? ' (Stop ' + arrivals_data[0].platformName + ')' : '');

				// Order bus arrivals by timeToStation
				arrivals_data.sort(function (a, b) {
					return a.timeToStation - b.timeToStation;
				});

				// Loop through buses and add them to speech
				let busArrivalsReturned = arrivals_data.length < MAX_BUS_ARRIVALS_RETURNED_SCREEN ? arrivals_data.length : MAX_BUS_ARRIVALS_RETURNED_SCREEN;
				for(let i = 0; i < busArrivalsReturned; i++) {
					text += arrivals_data[i].lineName + ' to ' + arrivals_data[i].destinationName + ': ' + (arrivals_data[i].timeToStation < 90 ? 'Due  \n' : Math.round(arrivals_data[i].timeToStation / 60) + ' minutes  \n');
				}
			}

			let destinationName = 'TfL Live arrivals';
			// let suggestionUrl = 'https://tfl.gov.uk/bus/stop/' + stop_data.matches[0].id + '/' + stop_data.matches[0].name.toLowerCase().replace(/\s+/g, '-');
			let suggestionUrl = 'https://tfl.gov.uk/travel-information/stations-stops-and-piers/';
			askWithBasicCardAndLink(speech, title, text, destinationName, suggestionUrl);
		} else {
			let speech = 'Unfortuantely live arrivals are not available at that stop at the moment.';
			if (arrivals_data.length != 0) {
				speech = '<speak>At ' + arrivals_data[0].stationName + (arrivals_data[0].platformName ? ' (Stop <say-as interpret-as="characters">' + arrivals_data[0].platformName + '</say-as>) ' : '');

				// Order bus arrivals by timeToStation
				arrivals_data.sort(function (a, b) {
					return a.timeToStation - b.timeToStation;
				});

				// Loop through buses and add them to speech
				let busArrivalsReturned = arrivals_data.length < MAX_BUS_ARRIVALS_RETURNED_NO_SCREEN ? arrivals_data.length : MAX_BUS_ARRIVALS_RETURNED_NO_SCREEN;
				for(let i = 0; i < busArrivalsReturned; i++) {
					speech += 'a ' + (arrivals_data[i].lineName.length > 2 ? '<say-as interpret-as="digits">' + arrivals_data[i].lineName + '</say-as>' : arrivals_data[i].lineName) + (arrivals_data[i].timeToStation < 90 ? ' is due' : ' is in ' + Math.round(arrivals_data[i].timeToStation / 60) + ' minutes');
					if(i < busArrivalsReturned - 2) {
						speech += ', ';
					} else if (i == busArrivalsReturned - 2) {
						speech += ' and ';
					}
				}
				speech += '. </speak>';
			}

			let destinationName = 'live arrivals';
			// let suggestionUrl = 'https://tfl.gov.uk/bus/stop/' + stop_data.matches[0].id + '/' + stop_data.matches[0].name.toLowerCase().replace(/\s+/g, '-');
			let suggestionUrl = 'https://tfl.gov.uk/travel-information/stations-stops-and-piers/';
			askWithLink(speech, destinationName, suggestionUrl);
		}
	}

	function busArrivalsListFollowup(app) {
		let busStopId = app.getSelectedOption();
		let url = 'https://api.tfl.gov.uk/StopPoint/' + busStopId + '/Arrivals';
		getJSON(url, processArrivalsData);
	}

	const actionMap = new Map();
	actionMap.set('air_quality', airQuality);
	actionMap.set('minicab_lookup', minicabLookup);
	actionMap.set('minicab_find', minicabFind);
	actionMap.set('minicab_call', minicabCall);
	actionMap.set('line_status', lineStatus);
	actionMap.set('bus_arrivals', busArrivals);
	actionMap.set('bus_arrivals_list_followup', busArrivalsListFollowup);
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

	function askWithImage(speech, imageDesc, imageUrl) {
		app.ask(app.buildRichResponse()
			.addSimpleResponse(speech)
			.addBasicCard(app.buildBasicCard().setImage(imageUrl, imageDesc))
		);
	}

	function askWithBasicCardAndLink(speech, title, text, destinationName, suggestionUrl) {
		app.ask(app.buildRichResponse()
			.addSimpleResponse(speech)
		    .addBasicCard(app.buildBasicCard(text)
			    .setTitle(title)
			    .addButton(destinationName, suggestionUrl)
		    )
		);
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
