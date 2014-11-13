var path = require('path');
var fs = require('fs-extra');
var async = require('async');
var _ = require('lodash');
var S = require('string');
var recursive = require('recursive-readdir');
var yaml = require('js-yaml');
var raml2html = require('raml2html');



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
    var staticPath = path.resolve(implPath, 'static');
    var execPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.executable.path);
    var copiedExecPath = path.resolve(staticPath, 'executable');
    var invokerPath = path.resolve(apiSpec.apispec_path, '..', apiSpec.invoker.path);

    var specRamlPath = path.resolve(implPath, 'spec.raml');
    var invokerJsonPath = path.resolve(implPath, 'invoker', 'invoker.json');
    var docsHtmlPath = path.resolve(implPath, 'docs.html');

    var implTplPath = process.env.IMPL_TEMPLATE_PATH;

    if (_.isEmpty(implTplPath)) {
      if (S(apiSpec.implementation.type).startsWith('java')) {
        implTplPath = path.resolve(__dirname, '..', 'impl-tpl-dropwizard');
      } else {
        implTplPath = path.resolve(__dirname, '..', 'impl-tpl-node');
      }
    }

    async.series([
      async.apply(fs.mkdirs, implPath), //TODO: check if this is needed
      function(callback) {
        if (implPath === implTplPath) callback();
        else fs.copy(implTplPath, implPath, callback);
      },
      async.apply(fs.copy, execPath, copiedExecPath),
      async.apply(fs.copy, invokerPath, path.join(implPath, 'invoker')),
      function(callback) {
        // Generate index.json
        recursive(copiedExecPath, function(err, files) {
          if (err) return callback(err);

          var index = {
            _links: {
              self: { href: '/' },
              spec: { href: '/api/v1/spec' },
              docs: { href: '/api/v1/docs' }
            }
          }

          _.each(files, function(file) {
            index._links[path.relative(copiedExecPath, file)] = { href: '/' + path.relative(staticPath, file) }
          });

          fs.writeFile(path.resolve(implPath, 'index.json'), JSON.stringify(index, null, 2), callback);
        });
      },
      function(callback) {
        // Generate spec.raml
        async.parallel({
          specRaml: async.apply(fs.readFile, specRamlPath, 'utf8'),
          invokerJson: async.apply(fs.readFile, invokerJsonPath)
        }, function(err, results) {
          if (err) return callback(err);

          specRaml = yaml.safeLoad(results.specRaml);

          if (apiSpec.executable.name) {
            specRaml.title = 'RESTful ' + apiSpec.executable.name;
          }

          // Customize schema
          invokerJson = JSON.parse(results.invokerJson);
          invokerJson.results = invokerJson.results || {};

          invokerJson.invoker_config.properties = invokerJson.invoker_config.schema;
          delete invokerJson.invoker_config.schema;

          var runSchema;

          _.each(specRaml.schemas, function(schema) {
            if (schema.run) runSchema = schema;
          });

          var parsedSchema = JSON.parse(runSchema.run);
          var params = parsedSchema.properties.parameters.properties;
          var results = parsedSchema.properties.results.properties;

          // Put invoker_config schema
          params.invoker_config = invokerJson.invoker_config;

          // Put other parameters
          _.each(apiSpec.parameters, function(val, key) {
            if (key === 'invoker_config') return;

            params[key] = { type: val.type };

            if (val.description) params[key].description = val.description;
            if (val.default) params[key].default = val.default;
            if (val.schema) params[key].properties = val.schema;
          });

          // Put results schema from invoker.json and API spec
          _.each(_.merge(invokerJson.results, apiSpec.results), function(val, key) {
            results[key] = { type: val.type };

            if (val.description) results[key].description = val.description;
            if (val.schema) results[key].properties = val.schema;

            if (val.mapping === 'stdout' || val.mapping === 'stderr') delete results[val.mapping];
          });

          runSchema.run = JSON.stringify(parsedSchema, null, 2);

          fs.writeFile(specRamlPath, '#%RAML 0.8\n---\n' + yaml.safeDump(specRaml), callback);
        });
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

      apiSpec.executable.path = path.join('static', 'executable');
      apiSpec.invoker.path = 'invoker';

      done(null, apiSpec);
    });
  };

  obj.generate = generate;
  obj.supports = supports;

  return obj;
};
