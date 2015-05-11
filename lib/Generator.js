var path = require('path');
var fs = require('fs-extra');
var async = require('async');
var _ = require('lodash');
var S = require('string');
var raml2html = require('raml2html');
var util = require('any2api-util');

//TODO WORKAROUND
//fs.copy = function(src, dest, callback) { fs.copySync(src, dest); callback(); };



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
    var specRaml;

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

    apiSpec.implementation.title = apiSpec.implementation.title || 'REST';
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
            fs.readFile(path.resolve(__dirname, '..', 'tpl', 'spec.raml.tpl'), 'utf8', function(err, content) {
              specRaml = content;

              callback(err);
            });
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

              fs.copy(invokerPath, path.resolve(implPath, invoker.path), callback);
            }, callback);
          }
        ], callback);
      },
      function(callback) {
        util.enrichSpec({ apiSpec: apiSpec, basePath: implPath }, callback);
      },
      function(callback) {
        // Generate spec.raml
        var docs = [];

        _.each([ 'executables', 'invokers' ], function(collection) {
          _.each(apiSpec[collection], function(item, name) {
            item.rest_url_path = collection + '/' + name;

            var doc = {};

            if (collection === 'executables') {
              doc.title = 'Executable ' + name;
              doc.content = item.description || '';

              if (item.readme) {
                doc.content += '\n\nREADME file of executable: ' +
                               '[' + item.readme + ']' +
                               '(/' + path.relative('static', path.join(item.path, item.readme))
                                .replace(/\\/g,'/') + ')';
              }
            } else {
              doc.title = 'Invoker ' + name;
              doc.content = 'Use this invoker to run arbitrary executables (supported by the invoker) in an ad-hoc manner.';

              if (item.description) {
                doc.content += '\n\n' + item.description;
              }
            }

            doc.content = indentStringify(doc.content);
            docs.push(doc);

            if (collection === 'executables') item.rest_schema_name = S('instance-executable-' + name).camelize().s;
            else item.rest_schema_name = S('instance-invoker-' + name).camelize().s;

            item.rest_schema = _.cloneDeep(util.instanceSchema);
            item.rest_schema['$schema'] = 'http://json-schema.org/draft-04/schema#';
            item.rest_schema.properties.parameters = {
              type: 'object',
              properties: { stdout: { type: 'string' }, 'stderr': { type: 'string' } }
            };
            item.rest_schema.properties.results = { type: 'object', properties: {} };
            item.rest_schema.properties._links = {
              type: 'object',
              patternProperties: {
                '[a-zA-Z0-9-_.]+': {
                  type: 'object',
                  properties: { href: { type: 'string' } }
                }
              }
            };

            // Parameters and results schema
            var paramsProps = item.rest_schema.properties.parameters.properties;
            var resultsProps = item.rest_schema.properties.results.properties;

            var paramsSchema = item.parameters_schema;
            var paramsRequired = item.parameters_required;
            var resultsSchema = item.results_schema;

            if (collection === 'invokers') {
              item.rest_schema.properties.executable = util.embeddedExecutableSchema;
            }

            populateSchemaProperties(paramsSchema, paramsProps);
            populateSchemaProperties(resultsSchema, resultsProps);

            item.rest_schema = indentStringify(item.rest_schema);

            // Generate examples
            var reqExample = util.generateExampleSync({ parameters_schema: paramsSchema,
                                                        parameters_required: paramsRequired });

            var resExample = _.clone(reqExample);

            resExample.id = 'eae393ac-b766-4ffc-a69b-d41e37b3f5b2';
            resExample.status = 'running';

            item.rest_req_example = indentStringify(reqExample);
            item.rest_res_example = indentStringify(resExample);
          });
        });

        specRaml = _.template(specRaml)({
          title: apiSpec.implementation.title,
          executables: apiSpec.executables,
          invokers: apiSpec.invokers,
          docs: docs
        });

        _.each([ 'executables', 'invokers' ], function(collection) {
          _.each(apiSpec[collection], function(item, name) {
            delete item.rest_schema_name;
            delete item.rest_schema;
            delete item.rest_req_example;
            delete item.rest_res_example;
          });
        });

        fs.writeFile(specRamlPath, specRaml, callback);
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



var indentStringify = function(input) {
  var indent = '                ';

  var str = '';

  if (!_.isString(input)) input = JSON.stringify(input, null, 2);

  var lines = input.split('\n');

  _.each(lines, function(line) {
    str += indent + line + '\n';
  });

  return str;
};

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
    } else if (def.type === 'xml_object' || def.type === 'binary' || def.type === 'string') {
      //TODO: consider type and content_type to enrich JSON schema definition
      // - https://github.com/json-schema/json-schema/wiki/Media
      // - https://github.com/fge/json-schema-formats/wiki
      // - http://json-schema.org/latest/json-schema-hypermedia.html
      // - http://spacetelescope.github.io/understanding-json-schema/reference/string.html

      props[name].type = 'string';
    }

    if (def.description) props[name].description = def.description;

    if (def.default) props[name].default = def.default;
    if (def.mapping === 'stdout' || def.mapping === 'stderr') delete props[def.mapping];
  });

  return props;
};
