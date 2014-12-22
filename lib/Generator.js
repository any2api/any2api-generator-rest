var path = require('path');
var fs = require('fs-extra');
var async = require('async');
var _ = require('lodash');
var S = require('string');
var yaml = require('js-yaml');
var raml2html = require('raml2html');
var util = require('any2api-util');



module.exports = function(spec) {
  var obj = {};

  //spec = spec || {};

  var supports = function(apiSpec) { //TODO: additionally support java, java-jersey, java-jaxrs, java-dropwizard
    if (_.contains([ 'node', 'node.js', 'nodejs' ], apiSpec.implementation.type.trim().toLowerCase()) &&
        _.contains([ 'rest', 'restful', 'http-rest' ], apiSpec.implementation.interface.trim().toLowerCase())) {
      return true;
    } else {
      return false;
    }
  };

  var generate = function(apiSpec, done) {
    var implPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.implementation.path);

    var specRamlPath = path.resolve(implPath, 'spec.raml');
    var docsHtmlPath = path.resolve(implPath, 'docs.html');

    var implTplPath = process.env.IMPL_TEMPLATE_PATH;

    var invokerJson = {};

    if (_.isEmpty(implTplPath)) {
      if (S(apiSpec.implementation.type).trim().toLowerCase().startsWith('java')) {
        implTplPath = path.resolve(__dirname, '..', 'tpl', 'impl-dropwizard');
      } else {
        implTplPath = path.resolve(__dirname, '..', 'tpl', 'impl-node');
      }
    }

    apiSpec.implementation.ports = [ '3000' ];

    async.series([
      //async.apply(fs.mkdirs, implPath),
      function(callback) {
        if (implPath === implTplPath) return callback();
        
        fs.copy(implTplPath, implPath, callback);
      },
      function(callback) {
        if (implPath === implTplPath) return callback();

        async.parallel([
          function(callback) {
            if (fs.existsSync(specRamlPath)) return callback();
        
            fs.copy(path.resolve(__dirname, '..', 'tpl', 'spec.raml'),
              specRamlPath, callback);
          },
          function(callback) {
            if (fs.existsSync(path.resolve(implPath, 'static', 'console'))) return callback();
        
            fs.copy(path.resolve(__dirname, '..', 'tpl', 'console'),
              path.resolve(implPath, 'static', 'console'), callback);
          },
          function(callback) {
            if (fs.existsSync(path.resolve(implPath, 'test'))) return callback();
        
            fs.copy(path.resolve(__dirname, '..', 'tpl', 'test'),
              path.resolve(implPath, 'test'), callback);
          }
        ], callback);
      },
      function(callback) {
        // Copy executables
        async.each(_.keys(apiSpec.executables), function(execName, callback) {
          var executable = apiSpec.executables[execName];
          var execPath = path.resolve(apiSpec.apispec_path, '..', executable.path);

          executable.path = path.join('static', 'executables', execName);

          fs.copy(execPath, path.resolve(implPath, executable.path), callback);
        }, callback);
      },
      function(callback) {
        // Copy invokers
        async.each(_.keys(apiSpec.invokers), function(invokerName, callback) {
          var invoker = apiSpec.invokers[invokerName];
          var invokerPath = path.resolve(apiSpec.apispec_path, '..', invoker.path);

          invoker.path = path.join('invokers', invokerName);

          fs.copy(invokerPath, path.resolve(implPath, 'invokers', invokerName), callback);
        }, callback);
      },
      function(callback) {
        // Read invoker.json files
        async.each(_.keys(apiSpec.invokers), function(invokerName, callback) {
          var invoker = apiSpec.invokers[invokerName];

          invokerJson[invokerName] = { parameters_schema: {}, results_schema: {} };

          fs.readFile(path.resolve(implPath, invoker.path, 'invoker.json'), 'utf8', function(err, content) {
            if (err) return callback(err);

            var parsed = JSON.parse(content);

            if (parsed.parameters_schema)
              invokerJson[invokerName].parameters_schema = parsed.parameters_schema;

            if (parsed.results_schema)
              invokerJson[invokerName].results_schema = parsed.results_schema;

            callback();
          });
        }, callback);
      },
      function(callback) {
        var specRaml;

        async.series([
          function(callback) {
            // Read spec.raml
            fs.readFile(specRamlPath, 'utf8', function(err, content) {
              if (err) return callback(err);

              specRaml = yaml.safeLoad(content);

              callback();
            });
          },
          function(callback) {
            // Adapt spec.raml
            specRaml.title = apiSpec.implementation.title || 'REST';
            specRaml.documentation = [];

            try {
              _.each(apiSpec.executables, function(executable, execName) {
                updateSpecRamlSync({ apiSpec: apiSpec, specRaml: specRaml,
                                     invokerJson: invokerJson, execName: execName });
              });

              _.each(apiSpec.invokers, function(invoker, invokerName) {
                updateSpecRamlSync({ apiSpec: apiSpec, specRaml: specRaml,
                                     invokerJson: invokerJson, invokerName: invokerName });
              });
            } catch (err) {
              return callback(err);
            }

            // Remove template route
            delete specRaml['/runs'];

            // Write spec.raml
            fs.writeFile(specRamlPath, '#%RAML 0.8\n---\n' + yaml.safeDump(specRaml), callback);
          }
        ], callback);
      },
      function(callback) {
        // Generate docs.html
        var config = raml2html.getDefaultConfig();

        raml2html.render(specRamlPath, config, function(html) {
          fs.writeFile(docsHtmlPath, html, callback);
        }, callback);
      }
    ], function(err) {
      if (err) return done(err);

      done(null, apiSpec);
    });
  };

  obj.generate = generate;
  obj.supports = supports;

  return obj;
};



var updateSpecRamlSync = function(args) {
  var specRaml = args.specRaml;
  var invokerJson = args.invokerJson;
  var invokerName = args.invokerName;
  var execName = args.execName;

  var invoker = args.apiSpec.invokers[invokerName];
  var executable = args.apiSpec.executables[execName];
  
  if (executable) {
    invokerName = executable.invoker_name;
    invoker = args.apiSpec.invokers[invokerName];
  }

  if (invoker && !invoker.expose && !executable) return;

  if (!invoker && !executable) throw new Error('neither invoker nor executable found');
  else if (!invoker && executable) throw new Error('no invoker found for executable');

  // Put documentation
  if (executable) {
    var execDocs = {
      title: 'Executable ' + execName,
      content: executable.description || ''
    };

    if (executable.readme) {
      execDocs.content += '\n\nREADME file of executable: ' +
                          '[' + executable.readme + ']' +
                          '(/' + path.relative('static', path.join(executable.path, executable.readme))
                            .replace(/\\/g,'/') + ')';
    }

    specRaml.documentation.push(execDocs);
  } else {
    var invokerDocs = {
      title: 'Invoker ' + invokerName,
      content: 'Use this invoker to run arbitrary, supported executables in an ad-hoc manner.'
    };

    if (invoker.description) {
      invokerDocs.content += '\n\n' + invoker.description;
    }

    specRaml.documentation.push(invokerDocs);
  }

  // Custom schema
  var runSchema;

  _.each(specRaml.schemas, function(schema) {
    if (schema.run) runSchema = schema.run;
  });

  var customSchemaName;

  if (invoker && !executable) customSchemaName = S('run-invoker-' + invokerName).camelize().s;
  else if (executable) customSchemaName = S('run-executable-' + execName).camelize().s;

  var customSchema = JSON.parse(runSchema);
  var params = customSchema.properties.parameters.properties;
  var results = customSchema.properties.results.properties;

  // Parameters schema
  var parameters_schema = _.cloneDeep(invokerJson[invokerName].parameters_schema);

  if (executable) parameters_schema = _.extend(parameters_schema, executable.parameters_schema);

  var parameters_required = invokerJson[invokerName].parameters_required || [];

  if (executable) parameters_required.concat(executable.parameters_required || []);

  _.each(parameters_schema, function(val, key) {
    params[key] = { type: val.type };

    if (val.description) params[key].description = val.description;
    if (val.properties) params[key].properties = val.properties;

    if (val.default) params[key].default = val.default;
  });

  if (invoker && !executable) {
    customSchema.properties.executable = util.embeddedExecutableSchema;
  }

  // Results schema
  var results_schema = _.cloneDeep(invokerJson[invokerName].results_schema);

  if (executable) results_schema = _.extend(results_schema, executable.results_schema);

  _.each(results_schema, function(val, key) {
    results[key] = { type: val.type };

    if (val.description) results[key].description = val.description;
    if (val.properties) results[key].properties = val.properties;

    if (val.mapping === 'stdout' || val.mapping === 'stderr') delete results[val.mapping];
  });

  var customSchemaWrapper = {};

  customSchemaWrapper[customSchemaName] = JSON.stringify(customSchema, null, 2);

  specRaml.schemas.push(customSchemaWrapper);

  // Custom route
  var customRoute = _.cloneDeep(specRaml['/runs']);

  if (invoker && !executable) specRaml['/invokers/' + invokerName + '/runs'] = customRoute;
  else if (executable) specRaml['/executables/' + execName + '/runs'] = customRoute;

  customRoute.post.body['application/json'].schema = customSchemaName;
  customRoute.post.responses['201'].body['application/json'].schema = customSchemaName;

  customRoute['/{runId}'].put.body['application/json'].schema = customSchemaName;
  customRoute['/{runId}'].put.responses['200'].body['application/json'].schema = customSchemaName;
  customRoute['/{runId}'].get.responses['200'].body['application/json'].schema = customSchemaName;

  // Generate examples
  var reqExample = util.generateExampleSync({ parameters_schema: parameters_schema,
                                              parameters_required: parameters_required });

  var resExample = util.generateExampleSync({ parameters_schema: parameters_schema,
                                              parameters_required: parameters_required });

  resExample._id = 'eae393ac-b766-4ffc-a69b-d41e37b3f5b2';
  resExample.status = 'running';

  customRoute.post.body['application/json'].example = JSON.stringify(reqExample, null, 2);
  customRoute.post.responses['201'].body['application/json'].example = JSON.stringify(resExample, null, 2);

  customRoute['/{runId}'].put.responses['200'].body['application/json'].example = JSON.stringify(resExample, null, 2);
  customRoute['/{runId}'].get.responses['200'].body['application/json'].example = JSON.stringify(resExample, null, 2);
};
