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
			} else if (pollution[0] == "low" && pollution[1] != "low" && pollution[1] != "none") {
				speech += randomFromArray(['It\'s good now at least. ', 'There\'s good news and bad news. ']);
			} else if (pollution[0] == "high" || pollution[1] == "high") {
				speech += 'Oh dear...';
			}

			let connector = 'and';
			if(pollution[0] != pollution[1]) {
				connector = 'but';
			}

            speech += 'Currently pollution is ' + pollution[0] + (pollution[1] != "none" ? ', ' + connector + ' is forecast to be ' + pollution[1] : '') + '. ' + data.currentForecast[1].forecastSummary + '.';
            let destinationName = 'Londonair Forecast';
            let suggestionUrl = 'http://www.londonair.org.uk/LondonAir/Forecast/';
			let suggestions = ['Do I pay the T-Charge?', 'What else can I ask?'];

            askWithLinkAndSuggestions(speech, destinationName, suggestionUrl, suggestions);
        });
	}

    function minicabLookup (app) {
		app.setContext('request_location_minicab');
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
                let title = 'Minicab operators';

				if (!app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
					speech += ' ';
					options.forEach(function (option) {
						speech += option.title + '. ';
					});
				}

                askWithList(speech, title, options);
            });
        } else {
            askSimpleResponseWithSuggestions('Unfortunately I can\'t get you nearby minicab operators without your location. What do you want to do now?', ['Tube status', 'Bus arrivals at 58848', 'What can I ask?']);
        }
    }

    function minicabCall (app) {
		let suggestionUrl = 'https://domdomegg.github.io/linkgenerator?href=tel%3A%2B' + app.getSelectedOption() + '&buttontext=Call%20Minicab%20Operator';
        askWithLinkAndSuggestions("Their number is " + app.getSelectedOption() + ". What would you like to do now?", 'Phone', suggestionUrl, ['Tube status', 'What else can I ask?', 'Exit']);
    }

    function lineStatus (app) {
		if(app.getRawInput().toUpperCase().match(/^([A-HK-PRSVWY][A-HJ-PR-Y])\s?([0][2-9]|[1-9][0-9])\s?[A-HJ-PR-Z]{3}$/)) {
			emissionsSurcharge(app);
			return false;
		}

        let busLines = app.getArgument('bus-line') || [];
        let undergroundLines = app.getArgument('underground-line') || [];

		let url = 'https://api.tfl.gov.uk/Line/Mode/tube%2Ctflrail%2Cdlr%2Coverground/Status?detail=false';
		if(busLines.length + undergroundLines.length > 0) {
            url = 'https://api.tfl.gov.uk/Line/' + [undergroundLines,busLines].join() +'/Status?detail=false';
		}

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
			let text = '';
			let title = 'Status updates';

            // Bad service lines
            badServiceLines.forEach(function (line) {
                speech += line.name + ((line.modeName == 'tube') ? ' line' : (line.modeName == 'bus') ? ' bus' : '') + ": " +  line.description + ". ";
				text += line.reason + '  \n  \n';
			});

			if(goodServiceLines.length > 0) {
				// Good service lines
	            speech += 'There is a good service on the '
	            goodServiceLines = goodServiceLines.map(function (line) {
	                return line.name + ((line.modeName == 'tube') ? ' line' : (line.modeName == 'bus') ? ' bus' : '');
	            });
	            if(goodServiceLines.length > 1) {
	                speech += goodServiceLines.slice(0, -1).join(', ') + ' and the ' + goodServiceLines[goodServiceLines.length - 1];
	            } else {
	                speech += goodServiceLines[0];
	            }
				speech += '.';

				if (busLines.length + undergroundLines.length == 1) {
					text = 'Good service';
				} else if (text == '') {
					text = speech;
				}
			}

			speech = speech.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
			if (busLines.length + undergroundLines.length == 1) {
				speech = '<speak><sub alias="' + speech + '">Sure. Here are the latest status updates for that line:</sub></speak>';
			} else {
				speech = '<speak><sub alias="' + speech + '">Sure. Here are the latest status updates for those lines:</sub></speak>';
			}

            // URL: use default, but if only one bus input link to that bus's page
            // If only multiple buses, link to the bus status page
            let destinationName = 'TfL Status Updates';
            let suggestionUrl = 'https://tfl.gov.uk/tube-dlr-overground/status/';
            if(undergroundLines.length == 0) {
                if(busLines.length == 1) {
                    destinationName = 'TfL ' + busLines[0].toUpperCase() + ' Bus Status';
                    suggestionUrl = 'https://tfl.gov.uk/bus/status/?input=' + busLines[0];
                } else if(busLines.length > 1) {
                    destinationName = 'TfL Bus Updates';
                    suggestionUrl = 'https://tfl.gov.uk/bus/status/';
                }
            }

			askWithBasicCardAndLinkAndSuggestions(speech, title, text, destinationName, suggestionUrl, ['How\'s the ' + Math.floor(Math.random() * (99) + 1) + ' bus?', randomFromArray(['Central line status', 'Victoria line status', 'District & Northern lines']), 'What else can I ask?']);
        });
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
						let speech = randomFromArray(['Sorry - I couldn\'t find that stop. What\'s the SMS code?',
													'Hmmm - I couldn\'t find that one. Can you repeat the SMS code?']);
						askSimpleResponseWithSuggestions(speech, ['What else can I ask?']);
					} else if (stop_data.total > 1) {
						// Show list of bus stops
						askSimpleResponseWithSuggestions('That\'s strange, an error occurred and I found multiple bus stops with that SMS code.', ['What else can I ask?']);
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
									if(stop.modes == "bus") {
										options.push({
											selectionKey: stop.id,
											title: (stop.commonName + (stop.stopLetter ? ' (' + stop.stopLetter + ')' : '')),
											synonyms: (stop.stopLetter && stop.indicator ? [stop.stopLetter, stop.indicator] : [])
										});
									}
								});
							});
						} else {
							stops_data.children.forEach(function (stop) {
								if(stop.modes == "bus") {
									options.push({
										selectionKey: stop.id,
										title: (stop.commonName + (stop.stopLetter ? ' (' + stop.stopLetter + ')' : '')),
										synonyms: (stop.stopLetter && stop.indicator ? [stop.stopLetter, stop.indicator] : [])
									});
								}
							});
						};

						if(options.length == 0) {
							askSimpleResponseWithSuggestions('Sorry I couldn\'t find a bus stop there.', ['What can you do?']);
						} else if(options.length == 1) {
							url = 'https://api.tfl.gov.uk/StopPoint/' + options[0].id + '/Arrivals';
							getJSON(url, processArrivalsData);
						}

						let speech = 'Which stop do you want arrivals information for?';
						let title = 'Bus stops';

						app.setContext('bus_arrivals_list_followup');
						askWithList(speech, title, options);
					});
				}
			});
		} else {
			// Prompt the user for a sms location code
			let speech = randomFromArray(['What\'s the name of your bus stop or its 5 digit bus stop code?',
										'What\'s the name of the bus stop or its bus stop code? The bus stop code is the 5-digit number on a sign at the bus stop.',
										'What\'s your bus stop\'s name or it\'s bus stop code on the bus stop pole, marked "For next bus information"?']);
			let imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/d/dc/Quex_Road_%28Stop_N%29_Countdown_SMS_Code.jpg';
			let imageDesc = 'Countdown SMS code example';

			askWithImage(speech, imageDesc, imageUrl);
		}
	}

	function processArrivalsData(arrivals_data) {
		if(arrivals_data[0]) {
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
				let suggestions = ['Arrivals at ' + randomFromArray(['58848', '52334', '52954', 'Bunhill Row', 'Fitzalan Street', 'Tyers Street']), 'How\'s the ' + Math.floor(Math.random() * (99) + 1) + ' bus?', 'What else can I ask?'];
				askWithBasicCardAndLinkAndSuggestions(speech, title, text, destinationName, suggestionUrl, suggestions);
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
						speech += 'a ' + arrivals_data[i].lineName + (arrivals_data[i].timeToStation < 90 ? ' is due' : ' is in ' + Math.round(arrivals_data[i].timeToStation / 60) + ' minutes');
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
		} else {
			askSimpleResponseWithSuggestions('Live arrival data is not available for that stop.', ['What else can you do?']);
		}
	}

	function busArrivalsListFollowup(app) {
		let busStopId = app.getSelectedOption();
		let url = 'https://api.tfl.gov.uk/StopPoint/' + busStopId + '/Arrivals';
		getJSON(url, processArrivalsData);
	}

	function emissionsSurcharge(app) {
		let numberplate = app.getRawInput().toUpperCase().match(/^([A-HK-PRSVWY][A-HJ-PR-Y])\s?([0][2-9]|[1-9][0-9])\s?[A-HJ-PR-Z]{3}$/);
		if(numberplate) {
			numberplate = numberplate[0];

			// Remove spaces
			numberplate = numberplate.replace(/\s/g, '');

			getJSON('https://api.tfl.gov.uk/Vehicle/EmissionSurcharge?vrm=' + numberplate, function (car) {
				let speech = 'I couldn\'t find details for your vehicle';

				if(car.compliance) {
					speech = '';
					if(car.make && car.model) {
						speech += 'Your ' + toTitleCase(car.make + ' ' + car.model) + ' is ';
					} else {
						speech += 'Your car is ';
					}

					switch (car.compliance) {
						case "Compliant":
							speech += 'not subject to the T-Charge.';
							speech += ' Careful though - this is just a guide, and I can\'t accept liability for its accuracy. Do you want to check another vehicle?';
							break;
						case "NotCompliant":
							speech += 'subject to the T-Charge.';
							speech += ' Careful though - this is just a guide, and I can\'t accept liability for its accuracy. Do you want to check another vehicle?';
							break;
						case "Exempt":
							speech += 'exempt from the T-Charge.';
							speech += ' Careful though - this is just a guide, and I can\'t accept liability for its accuracy. Do you want to check another vehicle?';
							break;
						default:
							speech = 'I couldn\'t find details for your vehicle with registration <say-as interpret-as="characters">' + registration + '</say-as>. Do you want to try again?';
					}
				} else {
					speech = 'I couldn\'t find details for your vehicle with registration <say-as interpret-as="characters">' + registration + '</say-as>. Do you want to try again?';
				}

				app.setContext('emissions_surcharge_tryagain');
				let destinationName = 'TfL Toxicity Charge';
				let suggestionUrl = 'https://tfl.gov.uk/modes/driving/emissions-surcharge';
				askWithLinkAndSuggestions(speech, destinationName, suggestionUrl, ['Yes', 'No']);
			});
		} else {
			// Ask for numberplate
			app.setContext('emissions_surcharge_numberplate');
			askSimpleResponse(randomFromArray([
				'Sorry I couldn\'t pick out your numberplate there - could you say it again?',
				'Sorry I didn\'t get your reg number. Could you say it again?',
				'I couldn\'t understand your registration number. Please can you repeat it for me?'
			]));
		}
	}

	function carouselSelect(app) {
		// Get the user's selection
		let param = app.getContextArgument('actions_intent_option', 'OPTION');
		if (param) {
			param = param.value;
		} else {
			app.ask('Sorry, I didn\'t understand that. What is it that you want to do?');
		}

		// Compare the user's selections to each of the item's keys
		if (param === 'bus_arrivals') {
			busArrivals(app);
		} else if (param === 'line_status') {
			lineStatus(app);
		} else if (param === 'air_quality') {
			airQuality(app);
		} else if (param === 'minicab_lookup') {
			minicabLookup(app);
		} else if (param === 'emissions_surcharge') {
			app.setContext('emissions_surcharge_numberplate');
			askSimpleResponseWithSuggestions('Sure. What\'s your registration number?', [randomFromArray(['LT61 BHT', 'BX15 KXG', 'LV13 ZTR', 'BU12 AWM', 'WM57 DZL', 'YD65 VYH'])]);
		} else {
			app.ask('Sorry, I didn\'t understand that. What is it that you want to do?');
		}
	}

	const actionMap = new Map();
	actionMap.set('air_quality', airQuality);
	actionMap.set('minicab_lookup', minicabLookup);
	actionMap.set('minicab_find', minicabFind);
	actionMap.set('minicab_call', minicabCall);
	actionMap.set('line_status', lineStatus);
	actionMap.set('bus_arrivals', busArrivals);
	actionMap.set('bus_arrivals_list_followup', busArrivalsListFollowup);
	actionMap.set('emissions_surcharge', emissionsSurcharge);
	actionMap.set('carousel_select', carouselSelect);
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

	function askSimpleResponseWithSuggestions(speech, suggestions) {
        if (app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
            app.ask(app.buildRichResponse()
                .addSimpleResponse(speech)
				.addSuggestions(suggestions)
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

	function askWithLinkAndSuggestions(speech, destinationName, suggestionUrl, suggestions) {
        if (app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
            app.ask(app.buildRichResponse()
                .addSimpleResponse(speech)
                .addSuggestionLink(destinationName, suggestionUrl)
				.addSuggestions(suggestions)
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

	function askWithBasicCardAndLinkAndSuggestions(speech, title, text, destinationName, suggestionUrl, suggestions) {
		app.ask(app.buildRichResponse()
			.addSimpleResponse(speech)
			.addBasicCard(app.buildBasicCard(text)
				.setTitle(title)
				.addButton(destinationName, suggestionUrl)
			)
			.addSuggestions(suggestions)
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

function toTitleCase(str) {
	return str.toLowerCase().split(' ').map(upperFirstChar).join(' ');
}

function randomFromArray(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}
