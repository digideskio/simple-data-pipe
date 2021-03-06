
'use strict';

var passport = require('passport');
var global = require('bluemix-helper-config').global;
var pipesSDK = require('simple-data-pipe-sdk');
var pipesDb = pipesSDK.pipesDb;
var sdpLog = pipesSDK.logging.getGlobalLogger();
var connectorAPI = require('./connectorAPI');
var util = require('util');


var passportAPI = {
	
	/**
	  * Add a configured passport strategy.
	  * @param {string} unique strategy name
	  * @param {Object} passport strategy
	  */
	addStrategy: function(name, strategy) {
		passport.use(name, strategy);
	},
	
	/**
	  * Remove passport strategy.
	  * @param {string} unique strategy name
	  */
	removeStrategy: function(name) {
		passport.unuse(name);
	},

	/**
	  * OAuth callback processing for passport. The request must include
	  * a state parameter containing the data pipe id for which OAuth processing
	  * is performed.
	  * @param {Object} req - request
	  * @param {Object} res - response
	  * @param {callback}
	  *
	  */
	authCallback: function(req, res, callback) {

				sdpLog.info('Starting Passport OAuth callback processing.');

				var errMsg = '';

				var state = null,
				    pipeId = null;
				
				if (req.query.state) {
					state = JSON.parse(req.query.state);
				}
				else if (req.session && req.session.state) {
					state = JSON.parse(req.session.state);
				}
				
				if (state) {
					pipeId = state.pipe;
				}
				
				if ( !pipeId ){
					sdpLog.error('Passport OAuth callback - data pipe configuration id is missing');
					return global.jsonError( res, 'Passport OAuth callback - data pipe configuration id is missing.');
				}
				
				// delegate OAuth callback processing to passport
				passport.authenticate(pipeId, { pipeId:pipeId }, function(err, user, info) {

					if(user)
						sdpLog.debug('Passport callback - user: ' + util.inspect(user));

					if(info)
						sdpLog.debug('Passport callback - info: ' + util.inspect(info));

					if (err) {
						// fatal authentication error
						sdpLog.error('Passport OAuth callback - authentication processing failed: ' + util.inspect(err,4));
						res.type('html').status(401).send('<html><body> Authentication failed with error ' +  err.statusCode + ' </body></html>');
					}
					else if (!user) {
						// fatal authentication error; no user profile was returned
						sdpLog.error('Passport OAuth callback - no user profile was returned.');
						res.type('html').status(401).send('<html><body> The user is not known to the data source. </body></html>');
					}
					else {

						// attach optionally returned info
						if (info) {
							user.info = info;
						}

						// fetch the data pipe configuration
						pipesDb.getPipe( pipeId, function( err, pipe ) {
							if ( err ){
								sdpLog.error('Passport OAuth callback - retrieval of data pipe configuration ' + pipeId + ' failed: ' + err);
								return global.jsonError( res, err );
							}
							
							// determine which connector can process this data pipe
							var connector = connectorAPI.getConnector( pipe );
							
							if ( !connector ){
								// no connector can process this data pipe configuration
								sdpLog.error('Passport OAuth callback - no connector is available for data pipe configuration  ' + pipeId + '.');
								return global.jsonError( res, 'Unable to find connector for data pipe configuration  ' + pipeId);
							}
							
							// protect against certain failures caused by the connector
							try {					

									// invoke the connector's passport authentication post-processing routine
									connector.passportAuthCallbackPostProcessing(user, 
																				 pipe, 
																				 function( err, pipe ){

										// raise an error if neither an error nor an updated data pipe configuration is returned										 		
										if((! err) && (! pipe)) {
											errMsg = 'The ' + connector.getId() + ' connector caused a fatal error during OAuth post-processing for data pipe configuration  ' + pipeId + ': no results were returned.';
											sdpLog.error(errMsg);
											return global.jsonError( res, errMsg);
										}										 			

										if ( err ){
											errMsg = 'The ' + connector.getId() + ' connector encountered a fatal error during OAuth post-processing for data pipe configuration  ' + pipeId + ': ' + err;
											sdpLog.error(errMsg);
											return res.type('html').status(401).send('<html><body>' + errMsg + '</body></html>');
										}
										else {
											sdpLog.info('The ' + connector.getId() + ' connector completed OAuth post-processing for data pipe configuration  ' + pipeId);
											return callback(null, pipe);
										}
										
									}, info);

								}
							catch(ex) {
								errMsg = 'The ' + connector.getId() + ' connector caused a fatal error (' + ex.name + ') during OAuth post-processing for data pipe configuration  ' + pipeId + ': ' + ex.message;
								sdpLog.error('Message: ' + errMsg);
								sdpLog.error('Call stack: ' + ex.stack);
								return callback(errMsg, null);	
							}

						}); // getPipe
					}
				})(req, res); // passport.authenticate				
	},


	initEndPoints: function(app) {
 
		//initiate passport authentication
		app.get('/auth/passport/:pipeid',
			function(req, res, next) {

				sdpLog.debug('Starting Passport OAuth authorization process for data pipe configuration ' + req.params.pipeid);

				req.session.state = JSON.stringify({pipe : req.params.pipeid, url: req.query.url});

				// determine which connector can process this data pipe
				connectorAPI.getConnectorForPipeId( req.params.pipeid, function (err, connector) {

					if(err) {
						sdpLog.error('Passport OAuth authentication step 1 - no connector is available  for data pipe configuration  ' + req.params.pipeid + '.');
						return global.jsonError( res, err );
					}

					var authorizationOptions = {};
					if (typeof connector.getPassportAuthorizationParams === 'function') { 
					    // retrieve data source specific OAuth authorization code call parameters from the connector
						authorizationOptions = connector.getPassportAuthorizationParams();
					}
					
					// add state parm to each authorization request: '{pipe: pipeid: url: returnUrl}'
					authorizationOptions.state = JSON.stringify({pipe : req.params.pipeid, url: req.query.url});

					sdpLog.debug('Passport authorization options: ' + JSON.stringify(authorizationOptions));

					// start Passport OAuth authentication process
					passport.authenticate(req.params.pipeid, 
						                  authorizationOptions)(req, res, next);

				});
							
			}
		);
		
		//nothing to be done - call callback
		passport.serializeUser(function(user, done) {
			done(null, user);
		});

		//nothing to be done - call callback
		passport.deserializeUser(function(obj, done) {
			done(null, obj);
		});
		
		app.use(passport.initialize());
		app.use(passport.session());
	}
};

module.exports = passportAPI;
