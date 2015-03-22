var path = require('path');
var fs = require('fs');
var shell = require('shelljs');
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
        if (implPath !== implTplPath) {
          shell.mkdir('-p', implPath);

          shell.cp('-rf', path.join(implTplPath, '*'), implPath);
        }

        callback();
      },
      function(callback) {
        if (implPath === implTplPath) return callback();

        if (!fs.existsSync(specRamlPath)) {
          shell.cp('-rf', path.resolve(__dirname, '..', 'tpl', 'spec.raml'),
            specRamlPath);
        }

        if (!fs.existsSync(path.resolve(implPath, 'static', 'console'))) {
          shell.cp('-rf', path.resolve(__dirname, '..', 'tpl', 'console', '*'),
            path.resolve(implPath, 'static', 'console'));
        }

        if (!fs.existsSync(path.resolve(implPath, 'test'))) {
          shell.cp('-rf', path.resolve(__dirname, '..', 'tpl', 'test', '*'),
            path.resolve(implPath, 'test'));
        }

        callback();
      },
      function(callback) {
        // Copy executables
        shell.mkdir('-p', path.resolve(implPath, 'static', 'executables'));

        async.each(_.keys(apiSpec.executables), function(execName, callback) {
          var executable = apiSpec.executables[execName];
          var execPath = path.resolve(apiSpec.apispec_path, '..', executable.path);

          executable.path = path.join('static', 'executables', execName);

          shell.cp('-rf', path.join(execPath, '*'), path.resolve(implPath, executable.path));

          callback();
        }, callback);
      },
      function(callback) {
        // Copy invokers
        shell.mkdir('-p', path.resolve(implPath, 'invokers'));

        async.each(_.keys(apiSpec.invokers), function(invokerName, callback) {
          var invoker = apiSpec.invokers[invokerName];
          var invokerPath = path.resolve(apiSpec.apispec_path, '..', invoker.path);

          invoker.path = path.join('invokers', invokerName);

          shell.cp('-rf', path.join(invokerPath, '*'), path.resolve(implPath, invoker.path));

          callback();
        }, callback);
      },
      function(callback) {
        util.enrichSpec({ apiSpec: apiSpec, basePath: implPath }, callback);
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
                updateSpecRamlSync({ apiSpec: apiSpec, specRaml: specRaml, execName: execName });
              });

              _.each(apiSpec.invokers, function(invoker, invokerName) {
                updateSpecRamlSync({ apiSpec: apiSpec, specRaml: specRaml, invokerName: invokerName });
              });
            } catch (err) {
              return callback(err);
            }

            // Remove template route
            delete specRaml['/instances'];

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
  var instanceSchema;

  _.each(specRaml.schemas, function(schema) {
    if (schema.instance) instanceSchema = schema.instance;
  });

  var customSchemaName;

  if (invoker && !executable) customSchemaName = S('instance-invoker-' + invokerName).camelize().s;
  else if (executable) customSchemaName = S('instance-executable-' + execName).camelize().s;

  var customSchema = JSON.parse(instanceSchema);
  var paramsProps = customSchema.properties.parameters.properties;
  var resultsProps = customSchema.properties.results.properties;

  var populateSchemaProperties = function(schema, props) {
    _.each(schema, function(def, name) {
      //def = _.clone(def);

      props[name] = { type: def.type };

      if (def.type === 'json_object') {
        props[name].type = 'object';

        if (def.json_schema) {
          _.extend(props[name], def.json_schema);

          //delete def.json_schema;
        }
      } else if (def.type === 'json_array') {
        props[name].type = 'array';

        if (def.json_schema) {
          _.extend(props[name], def.json_schema);

          //delete def.json_schema;
        }
      } else if (def.type === 'xml_object') {
        props[name].type = 'string';
      }

      if (def.description) props[name].description = def.description;

      if (def.default) props[name].default = def.default;
      if (def.mapping === 'stdout' || def.mapping === 'stderr') delete props[def.mapping];
    });

    return props;
  };

  // Parameters and results schema
  var paramsSchema = invoker.parameters_schema;
  var paramsRequired = invoker.parameters_required;
  var resultsSchema = invoker.results_schema;

  if (executable) {
    paramsSchema = executable.parameters_schema;
    paramsRequired = executable.parameters_required;
    resultsSchema = executable.results_schema;
  } else if (invoker && !executable) {
    customSchema.properties.executable = util.embeddedExecutableSchema;
  }

  populateSchemaProperties(paramsSchema, paramsProps);
  populateSchemaProperties(resultsSchema, resultsProps);

  var customSchemaWrapper = {};

  customSchemaWrapper[customSchemaName] = JSON.stringify(customSchema, null, 2);

  specRaml.schemas.push(customSchemaWrapper);

  // Custom route
  var customRoute = _.cloneDeep(specRaml['/instances']);

  if (invoker && !executable) specRaml['/invokers/' + invokerName + '/instances'] = customRoute;
  else if (executable) specRaml['/executables/' + execName + '/instances'] = customRoute;

  customRoute.post.body['application/json'].schema = customSchemaName;
  customRoute.post.responses['201'].body['application/json'].schema = customSchemaName;

  customRoute['/{instanceId}'].put.body['application/json'].schema = customSchemaName;
  customRoute['/{instanceId}'].put.responses['200'].body['application/json'].schema = customSchemaName;
  customRoute['/{instanceId}'].get.responses['200'].body['application/json'].schema = customSchemaName;

  // Generate examples
  var reqExample = util.generateExampleSync({ parameters_schema: paramsSchema,
                                              parameters_required: paramsRequired });

  var resExample = util.generateExampleSync({ parameters_schema: paramsSchema,
                                              parameters_required: paramsRequired });

  resExample._id = 'eae393ac-b766-4ffc-a69b-d41e37b3f5b2';
  resExample.status = 'running';

  customRoute.post.body['application/json'].example = JSON.stringify(reqExample, null, 2);
  customRoute.post.responses['201'].body['application/json'].example = JSON.stringify(resExample, null, 2);

  customRoute['/{instanceId}'].put.responses['200'].body['application/json'].example = JSON.stringify(resExample, null, 2);
  customRoute['/{instanceId}'].get.responses['200'].body['application/json'].example = JSON.stringify(resExample, null, 2);
};
